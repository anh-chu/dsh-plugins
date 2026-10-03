import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "@local/dsh-prompt-english";
export const inject = ["systemPrompt"];

const HERE = dirname(fileURLToPath(import.meta.url));
const CJK = /[\u4e00-\u9fff]/g;
const LOG = join(process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh"), "logs", "prompt-english.log");

/**
 * Sections replaced wholesale, keyed by the section name the owning plugin
 * registered. Upstream text changes do not break the swap: the section is
 * matched by name, not by its Chinese content.
 */
const REPLACEMENTS = new Map([["genui:fence", join(HERE, "genui-section.md")]]);

const reported = new Set();

function report(line) {
	if (reported.has(line)) return;
	reported.add(line);
	try {
		mkdirSync(dirname(LOG), { recursive: true });
		appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// A failed audit write must never break prompt assembly.
	}
}

/**
 * Rewrite named model-facing sections into English and audit the rest.
 * Runs at the tail of the assembly waterfall so it sees the final sections.
 * @param ctx - cordis context.
 */
export function apply(ctx) {
	ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
		const out = await next();
		for (const section of out?.sections ?? []) {
			const path = REPLACEMENTS.get(section.name);
			if (path !== undefined) {
				try {
					const english = readFileSync(path, "utf8").trimEnd();
					if (section.text !== english) section.text = english;
				} catch (error) {
					report(`could not read ${path} for section "${section.name}": ${error.message}`);
				}
				continue;
			}
			const text = section.text ?? "";
			const matches = text.match(CJK);
			if (matches) report(`section "${section.name}" still carries ${matches.length} CJK chars of ${text.length}`);
		}
		return out;
	});
}
