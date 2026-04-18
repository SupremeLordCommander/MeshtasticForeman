/**
 * Sync Version
 *
 * Copies the version from root package.json into electron-app/package.json
 * so electron-builder stamps the correct version into the installer.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const version = rootPkg.version;

const electronPkgPath = path.join(ROOT_DIR, 'electron-app', 'package.json');
const electronPkg = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8'));

if (electronPkg.version !== version) {
  console.log(`Syncing version: ${electronPkg.version} → ${version}`);
  electronPkg.version = version;
  fs.writeFileSync(electronPkgPath, JSON.stringify(electronPkg, null, 2) + '\n');
} else {
  console.log(`Version already in sync: ${version}`);
}
