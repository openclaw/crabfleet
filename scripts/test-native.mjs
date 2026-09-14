import { spawnSync } from "node:child_process";

const commands = [
  ["go", ["test", "-race", "./..."]],
  ["go", ["vet", "./..."]],
];

if (process.platform === "darwin") {
  commands.push(["pnpm", ["macos:test"]]);
} else {
  console.log(`macOS native tests: not run on ${process.platform} (requires macOS and Xcode).`);
}

for (const [command, args] of commands) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: new URL("../", import.meta.url),
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) {
    if (result.signal) console.error(`${command} stopped by ${result.signal}.`);
    process.exit(result.status || 1);
  }
}
