import js from "@eslint/js";
import globals from "globals";

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                ...globals.node,
                ...globals.express,
                process: "readonly",
                __dirname: "readonly",
                __filename: "readonly",
                module: "readonly",
                require: "readonly",
                console: "readonly",
            },
        },
        rules: {
            "no-unused-vars": "off",
            "no-undef": "error",
            "no-empty": "off"
        },
    },
];
