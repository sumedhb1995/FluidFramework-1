/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IValueFactory, IValueOpEmitter, IValueOperation, IValueType } from "./interfaces";

export class DistributedSetFactory<T> implements IValueFactory<DistributedSet<T>> {
    public load(emitter: IValueOpEmitter, raw: any[] = []): DistributedSet<T> {
        return new DistributedSet<any>(emitter, raw);
    }

    public store(value: DistributedSet<T>): any[] {
        return value.entries();
    }
}

export class DistributedSet<T> {
    private readonly internalSet: Set<T>;

    constructor(private readonly emitter: IValueOpEmitter, value: T[]) {
        this.internalSet = new Set(value);
    }

    /**
     * Can be set to register an event listener for when values are added or deleted from the set.
     */
    public onAdd = (value: T) => { return; };
    public onDelete = (value: T) => { return; };

    public add(value: T, submitEvent = true): DistributedSet<T> {
        if (!this.internalSet.has(value)) {
            this.internalSet.add(value);

            if (submitEvent) {
                this.emitter.emit("add", undefined, value);
            }

            this.onAdd(value);
        }

        return this;
    }

    public delete(value: T, submitEvent = true): DistributedSet<T> {
        if (this.internalSet.has(value)) {
            this.internalSet.delete(value);

            if (submitEvent) {
                this.emitter.emit("delete", value, value);
            }

            this.onDelete(value);
        }

        return this;
    }

    public entries(): T[] {
        return Array.from(this.internalSet.values());
    }
}

export class DistributedSetValueType implements IValueType<DistributedSet<any>> {
    public static Name = "distributedSet";

    public get name(): string {
        return DistributedSetValueType.Name;
    }

    public get factory(): IValueFactory<DistributedSet<any>> {
        return DistributedSetValueType._factory;
    }

    public get ops(): Map<string, IValueOperation<DistributedSet<any>>> {
        return DistributedSetValueType._ops;
    }

    private static readonly _factory: IValueFactory<DistributedSet<any>> = new DistributedSetFactory();
    private static readonly _ops: Map<string, IValueOperation<DistributedSet<any>>> =
        new Map<string, IValueOperation<DistributedSet<any>>>(
        [[
            "add",
            {
                process: (value, params, local, op) => {
                    // Local ops were applied when the message was created
                    if (local) {
                        return;
                    }

                    value.add(params, false);
                },
            },
        ],
        [
            "delete",
            {
                process: (value, params, local, op) => {
                    // Local ops were applied when the message was created
                    if (local) {
                        return;
                    }

                    value.delete(params, false);
                },
            },
        ]]);
}
