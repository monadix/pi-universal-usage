import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPiRoot, locatePiPackage } from "../scripts/pi-module.ts";

function withoutOverrides<T>(run: () => T): T {
  const savedPackage = process.env.PI_PACKAGE_DIR;
  const savedExtension = process.env.PI_UNIVERSAL_USAGE_PI_PACKAGE;
  delete process.env.PI_PACKAGE_DIR;
  delete process.env.PI_UNIVERSAL_USAGE_PI_PACKAGE;
  try {
    return run();
  } finally {
    if (savedPackage === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = savedPackage;
    if (savedExtension === undefined) delete process.env.PI_UNIVERSAL_USAGE_PI_PACKAGE;
    else process.env.PI_UNIVERSAL_USAGE_PI_PACKAGE = savedExtension;
  }
}

describe("pi module location", () => {
  it("resolves the installed package without an environment override", () => {
    // The package hides package.json behind exports, so this exercises the
    // entry-resolution fallback that plain package.json resolution cannot do.
    const located = withoutOverrides(() => locatePiPackage());
    assert.ok(located);
    assert.equal(located.source, "resolved package");
    assert.equal(isPiRoot(located.root), true);
  });

  it("honors an explicit package root", () => {
    const located = withoutOverrides(() => locatePiPackage());
    assert.ok(located);
    const saved = process.env.PI_PACKAGE_DIR;
    process.env.PI_PACKAGE_DIR = located.root;
    try {
      const override = locatePiPackage();
      assert.equal(override?.source, "env PI_PACKAGE_DIR");
      assert.equal(override?.root, located.root);
    } finally {
      if (saved === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = saved;
    }
  });
});
