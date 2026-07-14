import fs from 'fs';
import path from 'path';

// 1. Read the newly bumped version from package.json
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const newVersion = packageJson.version;

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

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✅ Updated manifest.json to version ${newVersion}`);