import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nondeterminism =
  "The engine must be a pure function of (seed, config, safeguards). Use the injected Clock or seeded PRNG.";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // PLAN.md: no Math.random or wall clock anywhere in the engine.
    files: ["packages/engine/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: nondeterminism },
        { object: "Date", property: "now", message: nondeterminism },
        { object: "performance", property: "now", message: nondeterminism },
        { object: "crypto", property: "getRandomValues", message: nondeterminism },
        { object: "crypto", property: "randomUUID", message: nondeterminism },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: nondeterminism,
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "setTimeout", message: nondeterminism },
        { name: "setInterval", message: nondeterminism },
      ],
    },
  },
  {
    // PLAN.md: the oracle must never import engine code, so it can disagree with it.
    files: ["packages/oracle/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@eob/engine", "@eob/engine/*", "**/engine/**", "**/engine"],
              message: "The oracle must be independent of the engine (PLAN.md, Oracle).",
            },
          ],
        },
      ],
    },
  },
);
