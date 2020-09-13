module.exports = {
    env: {
        es6: true,
        browser: false,
        node: true,
    },
    parserOptions: {
        ecmaVersion: 2018,
        sourceType: "module",
    },
    globals: {
        "__base": true,
    },
    extends: ["eslint:recommended"],
    rules: {
        "semi": ["warn", "always"],
        "comma-dangle": ["warn", "always-multiline"],
        "no-var": ["warn"],
        "arrow-spacing": ["error", { "before": true, "after": true }],
        "space-infix-ops": ["warn", { "int32Hint": true }],
        "keyword-spacing": ["warn", { "before": true, "after": true }],
        "space-unary-ops": [
            "warn",
            {
                "words": true,
                "nonwords": false,
            },
        ],
        "comma-spacing": ["warn", { "before": false, "after": true }],
        "object-curly-spacing": ["warn", "always"],
        //"arrow-parens": ["warn", "as-needed"],
        "no-unused-vars": ["error", {
            "vars": "all",
            "args": "after-used",
            "varsIgnorePattern": "[iIgnored]", // except variable explicitly declared as "ignored"
            "ignoreRestSiblings": false,
            "argsIgnorePattern": "^_", // except arguments explicitly declared as "not used" with a _ prefix,
            "caughtErrors": "all",
            "caughtErrorsIgnorePattern": "^ignore", // if an error object should be ignored, call it "ignore/d"
        }],
        "no-console": "warn",
        "no-extra-semi": "warn",
    },

    overrides: [
        {
            files: [
                "tests/**/*tests.js",
            ],
            env: {
                es6: true,
                browser: false,
                node: true,
                mocha: true,
                jest: true,
            },
            rules: {
                "no-console": "off",
            },
        },
    ],
};