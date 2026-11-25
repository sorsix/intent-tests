// Imported first by every CLI entry (compiled to plain JavaScript in the package, so it runs on any Node): the runner's .ts files need Node 22.18+,
// which runs TypeScript directly. Older Node would fail with an unclear "Unknown file extension .ts".
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `The intent test runner needs Node 22.18 or newer (it runs TypeScript directly); this is Node ${process.versions.node}.`,
  );
  process.exit(1);
}
