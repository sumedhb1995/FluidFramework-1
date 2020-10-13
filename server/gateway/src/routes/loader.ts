/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { parse } from "url";
import _ from "lodash";
import { ScopeType } from "@fluidframework/protocol-definitions";
import { IAlfredTenant } from "@fluidframework/server-services-client";
import { Router } from "express";
import safeStringify from "json-stringify-safe";
import jwt from "jsonwebtoken";
import { Provider } from "nconf";
import { v4 } from "uuid";
import winston from "winston";
import dotenv from "dotenv";
import { getSpfxFluidObjectData, spoEnsureLoggedIn } from "../gatewayOdspUtils";
import { resolveUrl } from "../gatewayUrlResolver";
import { IAlfred, IKeyValueWrapper } from "../interfaces";
import { getConfig, getJWTClaims, getUserDetails, queryParamAsString } from "../utils";
import { defaultPartials } from "./partials";

dotenv.config();

export function create(
    config: Provider,
    alfred: IAlfred,
    appTenants: IAlfredTenant[],
    ensureLoggedIn: any,
    cache: IKeyValueWrapper): Router {
    const router: Router = Router();
    const jwtKey = config.get("gateway:key");

    /**
     * Looks up the version of a chaincode in the cache.
     */
    const getUrlWithVersion = async (chaincode: string) => {
        return new Promise<string>((resolve) => {
            if (chaincode !== "" && chaincode.indexOf("@") === chaincode.lastIndexOf("@")) {
                cache.get(chaincode).then((value) => {
                    resolve(value as string);
                }, (err) => {
                    winston.error(err);
                    resolve(undefined);
                });
            } else {
                resolve(undefined);
            }
        });
    };

    /**
     * Loading of a specific Fluid document.
     */
    router.get("/:tenantId/*", spoEnsureLoggedIn(), ensureLoggedIn(), (request, response) => {
        const start = Date.now();
        const chaincode: string = queryParamAsString(request.query.chaincode);
        const driveId: string | undefined = queryParamAsString(request.query.driveId);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        getUrlWithVersion(chaincode).then((version: string) => {
            if (version) {
                const redirectUrl = `${request.originalUrl}@${version}`;
                winston.info(`Redirecting to ${redirectUrl}`);
                response.redirect(redirectUrl);
            } else {
                const claims = getJWTClaims(request);
                const jwtToken = jwt.sign(claims, jwtKey);

                const rawPath = request.params[0];
                const slash = rawPath.indexOf("/");
                const documentId = rawPath.substring(0, slash !== -1 ? slash : rawPath.length);
                const path = rawPath.substring(slash !== -1 ? slash : rawPath.length);

                const tenantId = request.params.tenantId;

                const search = parse(request.url).search;
                const scopes = [ScopeType.DocRead, ScopeType.DocWrite, ScopeType.SummaryWrite];
                const [resolvedP, fullTreeP] =
                    resolveUrl(config, alfred, appTenants, tenantId, documentId, scopes, request, driveId);

                const workerConfig = getConfig(
                    config.get("worker"),
                    tenantId,
                    config.get("error:track"));

                const spPackageP = getSpfxFluidObjectData();

                const scriptsP = spPackageP.then((manifest) => {
                    winston.info(JSON.stringify(manifest));

                    const baseUrl = manifest.loaderConfig.internalModuleBaseUrls[0] ?? "";
                    const scriptResources = manifest.loaderConfig.scriptResources[
                        `fluid.${manifest.loaderConfig.entryModuleId}`
                    ] ?? "";
                    const bundle = scriptResources.path;
                    return {
                        entrypoint: manifest.loaderConfig.entryModuleId,
                        scripts: [
                            {
                                id: baseUrl,
                                url: `${baseUrl}/${bundle}`,
                            },
                        ],
                    };
                });
                const pkgP = scriptsP.then((scripts) => {
                    return {
                        resolvedPackage: {
                            fluid: {
                                browser: {
                                    umd: {
                                        files: [scripts.scripts[0].url],
                                        library: "main",
                                    },
                                },
                            },
                            name: `@gateway/${v4()}`,
                            version: "0.0.0",
                        },
                        package: {
                            fluid: {
                                browser: {
                                    umd: {
                                        files: [scripts.scripts[0].url],
                                        library: "main",
                                    },
                                },
                            },
                            name: `@gateway/${v4()}`,
                            version: "0.0.0",
                        },
                        config: {
                            [`@gateway:cdn`]: scripts.scripts[0].url,
                        },
                        fluid: {
                            browser: {
                                umd: {
                                    files: [scripts.scripts[0].url],
                                    library: "main",
                                },
                            },
                        },
                        name: `@gateway/${v4()}`,
                        version: "0.0.0",
                    };
                });

                // const scriptsP = pkgP.then((pkg) => {
                //     winston.info(JSON.stringify(pkg));
                //     if (pkg === undefined) {
                //         return [];
                //     }

                //     const umd = pkg.resolvedPackage.fluid?.browser?.umd;
                //     if (umd === undefined) {
                //         return [];
                //     }

                //     return {
                //         entrypoint: umd.library,
                //         scripts: umd.files.map(
                //             (script, index) => {
                //                 return {
                //                     id: `${pkg.resolvedPackageCacheId}-${index}`,
                //                     url: script,
                //                 };
                //             }),
                //     };
                // });

                // Track timing
                const treeTimeP = fullTreeP.then(() => Date.now() - start);
                const pkgTimeP = pkgP.then(() => Date.now() - start);
                const timingsP = Promise.all([treeTimeP, pkgTimeP]);

                Promise.all([resolvedP, fullTreeP, pkgP, scriptsP, timingsP])
                    .then(([resolved, fullTree, pkg, scripts, timings]) => {
                        // Bug in TS3.7: https://github.com/microsoft/TypeScript/issues/33752
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        resolved!.url += path + (search ?? "");
                        winston.info(`render ${tenantId}/${documentId} +${Date.now() - start}`);

                        // Bug in TS3.7: https://github.com/microsoft/TypeScript/issues/33752
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        timings!.push(Date.now() - start);
                        const configClientId: string = config.get("login:microsoft").clientId;
                        response.render(
                            "loader",
                            {
                                cache: fullTree !== undefined ? JSON.stringify(fullTree.cache) : undefined,
                                chaincode: JSON.stringify(pkg),
                                clientId: _.isEmpty(configClientId)
                                ? process.env.MICROSOFT_CONFIGURATION_CLIENT_ID : configClientId,
                                config: workerConfig,
                                jwt: jwtToken,
                                partials: defaultPartials,
                                resolved: JSON.stringify(resolved),
                                scripts,
                                timings: JSON.stringify(timings),
                                title: documentId,
                                user: getUserDetails(request),
                            });
                    }, (error) => {
                        response.status(400).end(`ERROR: ${error.stack}\n${safeStringify(error, undefined, 2)}`);
                    }).catch((error) => {
                        response.status(500).end(`ERROR: ${error.stack}\n${safeStringify(error, undefined, 2)}`);
                    });
            }
        });
    });

    return router;
}
