#!/usr/bin/env node
/**
 * Runner de pruebas comparativas — AI Support Engine
 *
 * Ejecuta los 12 casos de tests/cases.json contra POST /api/analyze en ambos modos,
 * guarda la evidencia cruda y calcula las métricas contra el ground truth.
 *
 * Sin dependencias: usa fetch nativo (Node 18+).
 *
 * Uso:
 *   node tests/run-comparison.mjs
 *   node tests/run-comparison.mjs --base-url http://localhost:3000 --delay 500
 *   node tests/run-comparison.mjs --mode traditional --only C11,C12
 *   node tests/run-comparison.mjs --out /tmp/results.md --evidence-dir /tmp/evidence
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CATEGORIES = ["ACCESS", "BUG", "FEATURE", "SECURITY"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const CONTRACT_KEYS = ["category", "priority", "response", "requiresHumanReview", "mode"];

const USAGE = `
Runner de pruebas comparativas — AI Support Engine

  node tests/run-comparison.mjs [opciones]

Opciones:
  --base-url <url>       URL de la API          (default: http://localhost:3000)
  --mode <valor>         both|traditional|generative (default: both)
  --delay <ms>           Pausa entre peticiones  (default: 0; usar 500+ con planes gratuitos)
  --only <ids>           Subconjunto de casos, ej. C01,C11,C12
  --out <archivo>        Resultados en markdown (default: tests/results.md)
  --evidence-dir <dir>   Evidencia cruda        (default: tests/evidence)
  --help                 Esta ayuda
`.trim();

function parseArgs(argv) {
  const args = {
    baseUrl: "http://localhost:3000",
    mode: "both",
    delay: 0,
    only: null,
    out: path.join(ROOT, "tests", "results.md"),
    evidenceDir: path.join(ROOT, "tests", "evidence"),
  };
  const take = (i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`Falta el valor de ${argv[i]}`);
      process.exit(2);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--base-url": args.baseUrl = take(i++).replace(/\/+$/, ""); break;
      case "--mode": args.mode = take(i++); break;
      case "--delay": args.delay = Number(take(i++)); break;
      case "--only": args.only = take(i++).split(",").map((s) => s.trim().toUpperCase()); break;
      case "--out": args.out = path.resolve(take(i++)); break;
      case "--evidence-dir": args.evidenceDir = path.resolve(take(i++)); break;
      case "--help": case "-h": console.log(USAGE); process.exit(0); break;
      default:
        console.error(`Argumento desconocido: ${argv[i]}\n\n${USAGE}`);
        process.exit(2);
    }
  }
  if (!Number.isFinite(args.delay) || args.delay < 0) {
    console.error("--delay debe ser un número >= 0");
    process.exit(2);
  }
  if (!["both", "traditional", "generative"].includes(args.mode)) {
    console.error("--mode debe ser both, traditional o generative");
    process.exit(2);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)} %`);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Valida el contrato de respuesta (prompt/output.schema.json, sin dependencias). */
function validateContract(body, expectedMode) {
  const errors = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, errors: ["la respuesta no es un objeto JSON"] };
  }
  const keys = Object.keys(body).sort();
  const expectedKeys = [...CONTRACT_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
    errors.push(`claves ${JSON.stringify(keys)} != ${JSON.stringify(expectedKeys)}`);
  }
  if (!CATEGORIES.includes(body.category)) errors.push(`category inválida: ${JSON.stringify(body.category)}`);
  if (!PRIORITIES.includes(body.priority)) errors.push(`priority inválida: ${JSON.stringify(body.priority)}`);
  if (typeof body.response !== "string" || body.response.trim().length < 10) {
    errors.push("response vacía o demasiado corta");
  }
  if (typeof body.requiresHumanReview !== "boolean") errors.push("requiresHumanReview no es booleano");
  if (body.mode !== expectedMode) errors.push(`mode ${JSON.stringify(body.mode)} != ${JSON.stringify(expectedMode)}`);
  return { valid: errors.length === 0, errors };
}

async function postAnalyze(baseUrl, message, mode, timeoutMs) {
  const res = await fetch(`${baseUrl}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ message, mode }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(text);
  } catch {
    parseError = "la respuesta HTTP no es JSON válido";
  }
  return { status: res.status, text, json, parseError };
}

async function checkAlive(baseUrl) {
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}

function evaluate(c, mode, http) {
  const body = http.json;
  const contract = validateContract(body, mode);
  const gotCategory = body && CATEGORIES.includes(body.category) ? body.category : null;
  const gotPriority = body && PRIORITIES.includes(body.priority) ? body.priority : null;
  const categoryOk = gotCategory === c.expected.category;
  const priorityOk = gotPriority === c.expected.priority;
  const severityError =
    gotPriority && c.expected.priority
      ? Math.abs(PRIORITIES.indexOf(gotPriority) - PRIORITIES.indexOf(c.expected.priority))
      : null;

  return {
    id: c.id,
    mode,
    title: c.title,
    difficulty: c.difficulty,
    adversarial: Boolean(c.adversarial),
    expected: c.expected,
    httpStatus: http.status,
    contractValid: contract.valid,
    contractErrors: contract.errors,
    got: body
      ? {
          category: body.category ?? null,
          priority: body.priority ?? null,
          requiresHumanReview: body.requiresHumanReview ?? null,
          response: body.response ?? null,
        }
      : null,
    categoryOk,
    priorityOk,
    exactOk: categoryOk && priorityOk,
    severityError,
    reviewOk: body ? body.requiresHumanReview === c.expected.requiresHumanReview : false,
    rawText: http.text,
  };
}

function summarize(rows) {
  const total = rows.length;
  const sum = (pred) => rows.filter(pred).length;
  const withSeverity = rows.filter((r) => typeof r.severityError === "number");
  return {
    total,
    contract: sum((r) => r.contractValid),
    category: sum((r) => r.categoryOk),
    priority: sum((r) => r.priorityOk),
    exact: sum((r) => r.exactOk),
    review: sum((r) => r.reviewOk),
    severityAvg: withSeverity.length
      ? withSeverity.reduce((a, r) => a + r.severityError, 0) / withSeverity.length
      : null,
    adversarialTotal: sum((r) => r.adversarial),
    adversarialOk: sum((r) => r.adversarial && r.exactOk),
    errors: sum((r) => r.httpStatus !== 200),
  };
}

function cell(row) {
  if (row.httpStatus !== 200) return `ERROR ${row.httpStatus}`;
  if (!row.got) return "SIN JSON";
  return `${row.got.category ?? "?"}/${row.got.priority ?? "?"}`;
}

function buildMarkdown(rows, summary, meta) {
  const out = [];
  out.push("# Resultados de la comparación");
  out.push("");
  out.push(`Ejecutado: ${new Date().toISOString()} · API: \`${meta.baseUrl}\``);
  out.push(`Casos: ${meta.cases} · Modos: ${meta.modes.join(", ")}`);
  out.push("");
  out.push("| # | Dificultad | Esperado | Trad. | Contrato | ✓ | Gen. | Contrato | ✓ |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  const ids = [...new Set(rows.map((r) => r.id))];
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    const cats = r.expected.category + "/" + r.expected.priority;
    const byMode = (m) => rows.find((x) => x.id === id && x.mode === m);
    const t = byMode("traditional");
    const g = byMode("generative");
    const cellFor = (x) => (x ? cell(x) : "—");
    const contractFor = (x) => (x ? (x.contractValid ? "OK" : "FALLA") : "—");
    const okFor = (x) => (x ? (x.exactOk ? "✓" : "✗") : "—");
    out.push(
      `| ${r.id} | ${r.difficulty} | ${cats} | ${cellFor(t)} | ${contractFor(t)} | ${okFor(t)} | ${cellFor(g)} | ${contractFor(g)} | ${okFor(g)} |`
    );
  }
  out.push("");
  out.push("## Resumen");
  out.push("");
  out.push("| Métrica | Tradicional | Generativo |");
  out.push("|---|---|---|");
  const s = (m) => summary[m];
  const line = (label, fn) => out.push(`| ${label} | ${fn(s("traditional"))} | ${fn(s("generative"))} |`);
  line("Contrato válido %", (x) => (x ? pct(x.contract, x.total) : "—"));
  line("Acierto categoría %", (x) => (x ? pct(x.category, x.total) : "—"));
  line("Acierto prioridad %", (x) => (x ? pct(x.priority, x.total) : "—"));
  line("**Acierto exacto %**", (x) => (x ? pct(x.exact, x.total) : "—"));
  line("requiresHumanReview correcto %", (x) => (x ? pct(x.review, x.total) : "—"));
  line("Error de severidad (prom.)", (x) =>
    x && x.severityAvg !== null ? x.severityAvg.toFixed(2) : "—"
  );
  line("Adversariales acertados", (x) => (x ? `${x.adversarialOk}/${x.adversarialTotal}` : "—"));
  line("Errores HTTP", (x) => (x ? String(x.errors) : "—"));
  out.push("");
  out.push("## Respuestas y revisión cualitativa");
  out.push("");
  out.push("Marcar la lista de `tests/README.md` §6 sobre cada texto.");
  for (const r of rows) {
    out.push("");
    out.push(`### ${r.id} (${r.mode}) — ${r.title}`);
    out.push("");
    out.push(`Esperado: **${r.expected.category}/${r.expected.priority}** · obtenido: **${cell(r)}** · contrato: ${r.contractValid ? "OK" : "FALLA"}`);
    if (r.contractErrors.length) out.push(`\n> ${r.contractErrors.join("; ")}`);
    out.push("");
    out.push(`> ${oneLine(r.got?.response) || "(sin respuesta válida)"}`);
  }
  return out.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(await readFile(path.join(ROOT, "tests", "cases.json"), "utf8"));
  const all = Array.isArray(data.cases) ? data.cases : [];
  const cases = args.only ? all.filter((c) => args.only.includes(c.id)) : all;

  if (cases.length === 0) {
    console.error("No hay casos que ejecutar (revisa --only).");
    process.exit(2);
  }
  if (!(await checkAlive(args.baseUrl))) {
    console.error(`\nNo se pudo conectar a ${args.baseUrl}`);
    console.error("Levanta la API primero (por ejemplo: npm start) y verifica el puerto.\n");
    process.exit(1);
  }

  const modes = args.mode === "both" ? ["traditional", "generative"] : [args.mode];
  const timeoutMs = 30000;
  const allRows = [];

  for (const mode of modes) {
    const dir = path.join(args.evidenceDir, mode);
    await mkdir(dir, { recursive: true });
    console.log(`\n== modo ${mode} ==`);
    for (const c of cases) {
      let http;
      try {
        http = await postAnalyze(args.baseUrl, c.message, mode, timeoutMs);
      } catch (err) {
        console.error(`  ${c.id}: fallo de red — ${err.message}`);
        http = { status: 0, text: String(err.message), json: null, parseError: "sin respuesta" };
      }
      const row = evaluate(c, mode, http);
      allRows.push(row);
      await writeFile(
        path.join(dir, `${c.id}.json`),
        JSON.stringify(
          {
            caseId: c.id,
            mode,
            executedAt: new Date().toISOString(),
            httpStatus: http.status,
            request: { message: c.message, mode },
            response: http.json ?? http.text,
            expected: c.expected,
            evaluation: {
              contractValid: row.contractValid,
              contractErrors: row.contractErrors,
              categoryOk: row.categoryOk,
              priorityOk: row.priorityOk,
              exactOk: row.exactOk,
              severityError: row.severityError,
            },
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      const mark = row.exactOk ? "OK  " : "FALLA";
      console.log(
        `  ${mark} ${c.id} esperado ${c.expected.category}/${c.expected.priority} -> ${cell(row)}${row.contractValid ? "" : " (contrato inválido)"}`
      );
      if (args.delay) await sleep(args.delay);
    }
  }

  const byMode = {};
  for (const m of ["traditional", "generative"]) {
    byMode[m] = summarize(allRows.filter((r) => r.mode === m));
  }

  console.log("\n== resumen ==");
  for (const m of ["traditional", "generative"]) {
    const s = byMode[m];
    if (!s.total) continue;
    console.log(
      `  ${m.padEnd(11)} exacto ${pct(s.exact, s.total).padStart(7)} | categoría ${pct(s.category, s.total).padStart(7)} | prioridad ${pct(s.priority, s.total).padStart(7)} | contrato ${pct(s.contract, s.total).padStart(7)} | adversariales ${s.adversarialOk}/${s.adversarialTotal}`
    );
  }

  const md = buildMarkdown(allRows, byMode, {
    baseUrl: args.baseUrl,
    cases: cases.length,
    modes,
  });
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, md, "utf8");
  console.log(`\nResultados: ${args.out}`);
  console.log(`Evidencia: ${args.evidenceDir}\n`);

  if (allRows.some((r) => r.httpStatus !== 200)) {
    console.error("Hay casos con error HTTP: revísalos antes de usar los porcentajes.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
