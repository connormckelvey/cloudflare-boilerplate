#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Get package name and version type from command line args
const packageName = process.argv[2];
const versionType = process.argv[3];

if (!packageName || !versionType || !['patch', 'minor', 'major'].includes(versionType)) {
  console.error('Usage: npm run release <package-name> [patch|minor|major]');
  console.error('   or: npm run release:patch <package-name>');
  console.error('   or: npm run release:minor <package-name>');
  console.error('   or: npm run release:major <package-name>');
  console.error('');
  console.error('Example: npm run release prisma patch');
  process.exit(1);
}

const packageJsonPath = join(rootDir, 'packages', packageName, 'package.json');

// Check if package exists
try {
  readFileSync(packageJsonPath, 'utf8');
} catch {
  console.error(`Error: Package '${packageName}' not found in packages/`);
  process.exit(1);
}

try {
  // Read current version
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const currentVersion = packageJson.version;
  const [major, minor, patch] = currentVersion.split('.').map(Number);

  // Calculate new version
  let newVersion;
  switch (versionType) {
    case 'major':
      newVersion = `${major + 1}.0.0`;
      break;
    case 'minor':
      newVersion = `${major}.${minor + 1}.0`;
      break;
    case 'patch':
      newVersion = `${major}.${minor}.${patch + 1}`;
      break;
  }

  console.log(`Bumping version: ${currentVersion} → ${newVersion}`);

  // Update package.json
  packageJson.version = newVersion;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`✓ Updated packages/${packageName}/package.json to ${newVersion}`);

  // Check git status
  const gitStatus = execSync('git status --porcelain', { encoding: 'utf8', cwd: rootDir });
  const hasUncommittedChanges = gitStatus.trim().length > 0;

  if (hasUncommittedChanges) {
    console.log('\n⚠️  You have uncommitted changes. Staging version update...');
  }

  // Stage the version change
  execSync(`git add packages/${packageName}/package.json`, { stdio: 'inherit', cwd: rootDir });
  
  // Commit the version change
  const commitMessage = `chore: bump version to ${newVersion}`;
  execSync(`git commit -m "${commitMessage}"`, { stdio: 'inherit', cwd: rootDir });
  console.log(`✓ Committed version change`);

  // Create package-specific git tag
  const tag = `${packageName}@v${newVersion}`;
  execSync(`git tag ${tag}`, { stdio: 'inherit', cwd: rootDir });
  console.log(`✓ Created tag: ${tag}`);

  // Push commit and tag
  console.log(`\n🚀 Pushing commit and tag ${tag} to origin...`);
  execSync('git push origin HEAD', { stdio: 'inherit', cwd: rootDir });
  execSync(`git push origin ${tag}`, { stdio: 'inherit', cwd: rootDir });
  console.log(`\n✅ Success! Tag ${tag} pushed. GitHub Actions will now publish @cloudflare-boilerplate/${packageName}@${newVersion} to npm.`);

} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

