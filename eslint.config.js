import js from '@eslint/js'
import nodePlugin from 'eslint-plugin-n'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default [
    { ignores: ['node_modules/', 'app/storage/', 'app/logs/', 'app/data/', 'coverage/'] },
    js.configs.recommended,
    nodePlugin.configs['flat/recommended-module'],
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            'n/no-process-exit': 'off',
            'n/hashbang': 'off',
            eqeqeq: ['error', 'always'],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    prettier,
]
