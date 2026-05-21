'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('admin jsonConfig migration', () => {
    const rootDir = __dirname;

    it('uses json adminUI in io-package', () => {
        const ioPackage = JSON.parse(fs.readFileSync(path.join(rootDir, 'io-package.json'), 'utf8'));

        assert.equal(ioPackage.common?.adminUI?.config, 'json');
    });

    it('contains jsonConfig and short-form i18n files', () => {
        assert.equal(fs.existsSync(path.join(rootDir, 'admin', 'jsonConfig.json')), true);
        assert.equal(fs.existsSync(path.join(rootDir, 'admin', 'i18n', 'en.json')), true);
        assert.equal(fs.existsSync(path.join(rootDir, 'admin', 'i18n', 'de.json')), true);
    });
});
