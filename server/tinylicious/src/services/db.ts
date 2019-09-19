/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ICollection, IDb } from "@microsoft/fluid-server-services-core";
import { EventEmitter } from "events";
import { Collection } from "./collection";

export class DB extends EventEmitter implements IDb {
    private collections = new Map<string, Collection<any>>();

    public async close(): Promise<void> {
        return;
    }

    public collection<T>(name: string): ICollection<T> {
        if (!this.collections.has(name)) {
            const collection = new Collection();
            this.collections.set(name, collection);
        }

        return this.collections.get(name);
    }
}
