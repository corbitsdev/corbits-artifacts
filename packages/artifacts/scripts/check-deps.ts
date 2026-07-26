// The one dependency rule left: nothing here may import the unpublished
// @workbench/* scope — it does not exist on npm, so a leak makes the package
// uninstallable for everyone outside the monorepo.
import { execSync } from "node:child_process";

try {
  const hits = execSync(
    `grep -rn '@workbench/' src ../../examples --include='*.ts' || true`,
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
  ).trim();
  if (hits) {
    console.error(`check-deps: unpublished @workbench/* import found:\n${hits}`);
    process.exit(1);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
console.log("check-deps: clean — no @workbench/* imports.");
