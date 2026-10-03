// Runnable check: the assembly waterfall replaces the genui:fence section with
// English, leaves other sections alone, and audits untranslated CJK sections.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { apply } from "./index.js";

const listeners = new Map();
apply({ on: (event, handler) => listeners.set(event, handler) });

const assemble = listeners.get("system-prompt/assemble");
assert.ok(assemble, "registered a system-prompt/assemble listener");

const assembly = {
	sections: [
		{ name: "genui:fence", text: "默认就该出 UI：出现下列情况至少出一个围栏，字段名写错 = 该组件被丢弃。" },
		{ name: "other:section", text: "left alone" },
		{ name: "mystery:section", text: "这个段落仍是中文" }
	],
	contexts: [],
	tools: [],
	variables: {}
};

const out = await assemble(assembly, {}, async () => assembly);
const section = (n) => out.sections.find((s) => s.name === n);

assert.ok(!/[\u4e00-\u9fff]/.test(section("genui:fence").text), "genui:fence is English now");
assert.equal(section("other:section").text, "left alone", "unrelated sections untouched");
assert.equal(section("mystery:section").text, "这个段落仍是中文", "audited section is not silently rewritten");

// The contract the section must keep teaching, spot-checked.
for (const needle of ["Default to UI", "validate_dsh_ui", "panel:true", "Secrets ban", "LOCAL-FIRST", "dsh-ui"]) {
	assert.ok(section("genui:fence").text.includes(needle), `translated section keeps "${needle}"`);
}

const log = readFileSync(`${process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`}/logs/prompt-english.log`, "utf8");
assert.ok(log.includes("mystery:section"), "audit logged the untranslated section");

console.log("ok: genui:fence replaced with English, contract strings intact, CJK audit logged");
