/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert, Deferred } from "@fluidframework/common-utils";
import { ITelemetryLogger } from "@fluidframework/common-definitions";
import { fluidEpochMismatchError, OdspErrorType } from "@fluidframework/odsp-doclib-utils";
import { ThrottlingError } from "@fluidframework/driver-utils";
import { IConnected } from "@fluidframework/protocol-definitions";
import { fetchAndParseAsJSONHelper, fetchHelper, IOdspResponse } from "./odspUtils";
import { ICacheEntry, IFileEntry, LocalPersistentCacheAdapter } from "./odspCache";
import { RateLimiter } from "./rateLimiter";
import { throwOdspNetworkError } from "./odspError";

export type FetchType = "blob" | "createBlob" | "createFile" | "joinSession" | "ops" | "other" | "snapshotTree" |
    "treesLatest" | "uploadSummary" | "push" | "versions";

/**
 * This class is a wrapper around fetch calls. It adds epoch to the request made so that the
 * server can match it with its epoch value in order to match the version.
 * It also validates the epoch value received in response of fetch calls. If the epoch does not match,
 * then it also clears all the cached entries for the given container.
 */
export class EpochTracker {
    private _fluidEpoch: string | undefined;
    private _fileEntry: IFileEntry | undefined;
    public readonly rateLimiter: RateLimiter;

    constructor(
        private readonly persistedCache: LocalPersistentCacheAdapter,
        private readonly logger: ITelemetryLogger,
    ) {
        // Limits the max number of concurrent requests to 24.
        this.rateLimiter = new RateLimiter(24);
    }

    public set fileEntry(fileEntry: IFileEntry | undefined) {
        assert(this._fileEntry === undefined, "File Entry should be set only once");
        assert(fileEntry !== undefined, "Passed file entry should not be undefined");
        this._fileEntry = fileEntry;
    }

    public get fileEntry(): IFileEntry | undefined {
        return this._fileEntry;
    }

    public get fluidEpoch() {
        return this._fluidEpoch;
    }

    public async validateEpochFromPush(details: IConnected) {
        const epoch = details.epoch;
        assert(epoch !== undefined, "Connection details should contain epoch");
        try {
            this.validateEpochFromResponse(epoch, "push");
        } catch (error) {
            await this.checkForEpochError(error, epoch, "push");
            throw error;
        }
    }

    public async fetchFromCache<T>(
        entry: ICacheEntry,
        maxOpCount: number | undefined,
        fetchType: FetchType,
    ): Promise<T | undefined> {
        const value = await this.persistedCache.get(entry, maxOpCount);
        if (value !== undefined) {
            try {
                this.validateEpochFromResponse(value.fluidEpoch, fetchType, true);
            } catch (error) {
                await this.checkForEpochError(error, value.fluidEpoch, fetchType, true);
                throw error;
            }
            return value.value as T;
        }
    }

    /**
     * Api to fetch the response for given request and parse it as json.
     * @param url - url of the request
     * @param fetchOptions - fetch options for request containing body, headers etc.
     * @param fetchType - method for which fetch is called.
     * @param addInBody - Pass True if caller wants to add epoch in post body.
     */
    public async fetchAndParseAsJSON<T>(
        url: string,
        fetchOptions: {[index: string]: any},
        fetchType: FetchType,
        addInBody: boolean = false,
    ): Promise<IOdspResponse<T>> {
        // Add epoch in fetch request.
        const request = this.addEpochInRequest(url, fetchOptions, addInBody);
        let epochFromResponse: string | null | undefined;
        try {
            const response = await this.rateLimiter.schedule(
                async () => fetchAndParseAsJSONHelper<T>(request.url, request.fetchOptions),
            );
            epochFromResponse = response.headers.get("x-fluid-epoch");
            this.validateEpochFromResponse(epochFromResponse, fetchType);
            return response;
        } catch (error) {
            await this.checkForEpochError(error, epochFromResponse, fetchType);
            throw error;
        }
    }

    /**
     * Api to fetch the response as it is for given request.
     * @param url - url of the request
     * @param fetchOptions - fetch options for request containing body, headers etc.
     * @param fetchType - method for which fetch is called.
     * @param addInBody - Pass True if caller wants to add epoch in post body.
     */
    public async fetchResponse(
        url: string,
        fetchOptions: {[index: string]: any},
        fetchType: FetchType,
        addInBody: boolean = false,
    ): Promise<Response> {
        // Add epoch in fetch request.
        const request = this.addEpochInRequest(url, fetchOptions, addInBody);
        let epochFromResponse: string | null | undefined;
        try {
            const response = await this.rateLimiter.schedule(
                async () => fetchHelper(request.url, request.fetchOptions),
            );
            epochFromResponse = response.headers.get("x-fluid-epoch");
            this.validateEpochFromResponse(epochFromResponse, fetchType);
            return response;
        } catch (error) {
            await this.checkForEpochError(error, epochFromResponse, fetchType);
            throw error;
        }
    }

    private addEpochInRequest(
        url: string,
        fetchOptions: {[index: string]: any},
        addInBody: boolean): {url: string, fetchOptions: {[index: string]: any}} {
        if (this.fluidEpoch !== undefined) {
            if (addInBody) {
                // We use multi part form request for post body where we want to use this.
                // So extract the form boundary to mark the end of form.
                let body: string = fetchOptions.body;
                const formBoundary = body.split("\r\n")[0].substring(2);
                body += `\r\nepoch=${this.fluidEpoch}\r\n`;
                body += `\r\n--${formBoundary}--`;
                fetchOptions.body = body;
            } else {
                const [mainUrl, queryString] = url.split("?");
                const searchParams = new URLSearchParams(queryString);
                searchParams.append("epoch", this.fluidEpoch);
                const urlWithEpoch = `${mainUrl}?${searchParams.toString()}`;
                if (urlWithEpoch.length > 2048) {
                    // Add in headers if the length becomes greater than 2048
                    // as ODSP has limitation for queries of length more that 2048.
                    fetchOptions.headers = {
                        ...fetchOptions.headers,
                        "x-fluid-epoch": this.fluidEpoch,
                    };
                } else {
                    return {
                        url: urlWithEpoch,
                        fetchOptions,
                    };
                }
            }
        }
        return { url, fetchOptions };
    }

    protected validateEpochFromResponse(
        epochFromResponse: string | undefined | null,
        fetchType: FetchType,
        fromCache: boolean = false,
    ) {
        this.checkForEpochErrorCore(epochFromResponse);
        if (epochFromResponse) {
            if (this._fluidEpoch === undefined) {
                this.logger.sendTelemetryEvent(
                    {
                        eventName: "EpochLearnedFirstTime",
                        epoch: epochFromResponse,
                        fetchType,
                        fromCache,
                    },
                );
            }
            this._fluidEpoch = epochFromResponse;
        }
    }

    private async checkForEpochError(
        error: any,
        epochFromResponse: string | null | undefined,
        fetchType: FetchType,
        fromCache: boolean = false,
    ) {
        if (error.errorType === OdspErrorType.epochVersionMismatch) {
            try {
                // This will only throw if it is an epoch error.
                this.checkForEpochErrorCore(epochFromResponse, error.errorMessage);
            } catch (epochError) {
                const err = {
                    ...epochError,
                    fromCache,
                    clientEpoch: this.fluidEpoch,
                    fetchType,
                };
                this.logger.sendErrorEvent({ eventName: "EpochVersionMismatch" }, err);
                assert(!!this.fileEntry, "File Entry should be set to clear the cached entries!!");
                // If the epoch mismatches, then clear all entries for such file entry from cache.
                await this.persistedCache.removeEntries(this.fileEntry);
                throw epochError;
            }
            // If it was categorised as epoch error but the epoch returned in response matches with the client epoch
            // then it was coherency 409, so rethrow it as throttling error so that it can retried. Default throttling
            // time is 1s.
            this.logger.sendErrorEvent({ eventName: "Coherency409" }, error);
            throw new ThrottlingError(error.errorMessage, 1000, 429);
        }
    }

    private checkForEpochErrorCore(epochFromResponse: string | null | undefined, message?: string) {
        // If epoch is undefined, then don't compare it because initially for createNew or TreesLatest
        // initializes this value. Sometimes response does not contain epoch as it is still in
        // implementation phase at server side. In that case also, don't compare it with our epoch value.
        if (this.fluidEpoch && epochFromResponse && (this.fluidEpoch !== epochFromResponse)) {
            throwOdspNetworkError(message ?? "Epoch Mismatch", fluidEpochMismatchError);
        }
    }
}

export class EpochTrackerWithRedemption extends EpochTracker {
    private readonly treesLatestDeferral = new DeferralWithCallback();

    protected validateEpochFromResponse(
        epochFromResponse: string | undefined | null,
        fetchType: FetchType,
        fromCache: boolean = false,
    ) {
        super.validateEpochFromResponse(epochFromResponse, fetchType, fromCache);

        // Any successful call means we have access to a file, i.e. any redemption that was required already happened.
        // That covers cases of "treesLatest" as well as "getVersions" or "createFile" - all the ways we can start
        // exploring a file.
        this.treesLatestDeferral.deferral.resolve();
    }

    public async fetchAndParseAsJSON<T>(
        url: string,
        fetchOptions: {[index: string]: any},
        fetchType: FetchType,
        addInBody: boolean = false,
    ): Promise<IOdspResponse<T>> {
        // Optimize the flow if we know that treesLatestDeferral was already completed by the timer we started
        // joinSession call. If we did - there is no reason to repeat the call as it will fail with same error.
        const completed = this.treesLatestDeferral.deferral.isCompleted;

        try {
            return await super.fetchAndParseAsJSON<T>(url, fetchOptions, fetchType, addInBody);
        } catch (error) {
            // Only handling here treesLatest. If createFile failed, we should never try to do joinSession.
            // Similar, if getVersions failed, we should not do any further storage calls.
            // So treesLatest is the only call that can have parallel joinSession request.
            if (fetchType === "treesLatest") {
                this.treesLatestDeferral.deferral.reject(error);
            }
            if (fetchType !== "joinSession" || error.statusCode !== 404 || completed) {
                throw error;
            }
        }

        // It is joinSession failing with 404.
        // Repeat after waiting for treeLatest succeeding (of fail if it fails).
        // No special handling after first call - if file has been deleted, then it's game over.
        await this.treesLatestDeferral.triggerCallbackAndAwaitPromise();
        return super.fetchAndParseAsJSON<T>(url, fetchOptions, fetchType, addInBody);
    }
}

class DeferralWithCallback {
    public readonly deferral;
    private callback?: () => Promise<any>;

    constructor() {
        this.deferral = new Deferred<void>();
    }

    setCallback(callback) {
        this.callback = callback;
    }

    async triggerCallbackAndAwaitPromise() {
        if (this.callback) {
            await this.callback();
        }
        await this.deferral.promise;
    }
}
