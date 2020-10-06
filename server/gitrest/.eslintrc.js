/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

module.exports = {
    "extends": [
        "@fluidframework/eslint-config-fluid/eslint7"
    ],
    "rules": {
        "@typescript-eslint/strict-boolean-expressions": "off", // requires strictNullChecks=true in tsconfig
        "prefer-arrow/prefer-arrow-functions": "off",
    }
}
