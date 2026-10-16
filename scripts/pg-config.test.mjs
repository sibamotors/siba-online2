import assert from "node:assert/strict";
import { test } from "node:test";
import { sslFor } from "./pg-config.mjs";

function withSslMode(mode, run) {
  const previous = process.env.DATABASE_SSL;
  if (mode === undefined) delete process.env.DATABASE_SSL;
  else process.env.DATABASE_SSL = mode;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_SSL;
    else process.env.DATABASE_SSL = previous;
  }
}

test("external PostgreSQL defaults to TLS with certificate verification", () => {
  withSslMode(undefined, () => {
    assert.deepEqual(sslFor("postgres://user:pass@db.example.com:5432/app"), {
      rejectUnauthorized: true,
    });
  });
});

test("local/private host does not get forced through external TLS defaults", () => {
  withSslMode(undefined, () => {
    assert.equal(sslFor("postgres://user:pass@localhost:5432/app"), false);
    assert.equal(sslFor("postgres://user:pass@db-internal:5432/app"), false);
  });
});

test("explicit require verifies certificates and explicit disable remains opt-in", () => {
  withSslMode("require", () => {
    assert.deepEqual(sslFor("postgres://user:pass@db.example.com:5432/app"), {
      rejectUnauthorized: true,
    });
  });
  withSslMode("disable", () => {
    assert.equal(sslFor("postgres://user:pass@db.example.com:5432/app"), false);
  });
});

test("explicit sslmode in the URL is delegated to node-postgres", () => {
  withSslMode(undefined, () => {
    assert.equal(sslFor("postgres://user:pass@db.example.com:5432/app?sslmode=require"), undefined);
  });
});
