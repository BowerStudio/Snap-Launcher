import fs from 'fs';
import path from 'path';

// 1. Determine the version: either passed on the command line
//    (node bump-version.mjs 1.2.3) or read from package.json
const requestedVersion = process.argv[2];
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

let newVersion;

if (requestedVersion) {
    if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(requestedVersion)) {
        console.error(`❌ "${requestedVersion}" is not a valid version. Expected format: 1.2.3 or 1.2.3.0`);
        process.exit(1);
    }
    newVersion = requestedVersion;

    packageJson.version = newVersion;
    fs.writeFileSync('./package.json', JSON.stringify(packageJson, null, '\t') + '\n');
    console.log(`✅ Updated package.json to version ${newVersion}`);
} else {
    newVersion = packageJson.version;
}

// 2. Locate your specific .sdPlugin directory
const pluginDir = fs.readdirSync('.').find(dir => dir.endsWith('.sdPlugin'));

if (!pluginDir) {
    console.error("❌ Could not find the .sdPlugin directory.");
    process.exit(1);
}

// 3. Read, update, and save the manifest.json
const manifestPath = path.join(pluginDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

manifest.Version = newVersion;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
console.log(`✅ Updated manifest.json to version ${newVersion}`);
