import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { parse, stringify } from "yaml";
import { projectSchema } from "../../scan/src/index.ts";

interface Question {
  key: string;
  parts: string[];
  type: "boolean" | "string" | "url" | "account" | "distribution";
  prompt: string;
  explanation: string;
  source: string | null;
}

const QUESTIONS: Question[] = [
  {
    key: "attestations.apple.xcode-sdk",
    parts: ["attestations", "apple.xcode-sdk"],
    type: "boolean",
    prompt: "Was this iOS upload built with Xcode 26 and an iOS 26 SDK?",
    explanation: "Since 28 April 2026, App Store Connect uploads need Xcode 26 or later and an iOS 26, iPadOS 26, tvOS 26, visionOS 26, or watchOS 26 SDK. The project source does not contain the Xcode version.",
    source: "https://developer.apple.com/news/upcoming-requirements/",
  },
  {
    key: "attestations.apple.age-rating",
    parts: ["attestations", "apple.age-rating"],
    type: "boolean",
    prompt: "Have you answered Apple's updated age-rating questions in App Store Connect?",
    explanation: "Apple required those answers by 31 January 2026 so updates would not be interrupted. LaunchyMind does not copy the new rating values and does not open App Store Connect.",
    source: "https://developer.apple.com/news/upcoming-requirements/",
  },
  {
    key: "attestations.apple.login-exception",
    parts: ["attestations", "apple.login-exception"],
    type: "boolean",
    prompt: "If another login is offered, does an Apple guideline 4.8 exception apply?",
    explanation: "Leave this blank when you are not claiming an exception. A yes is your statement, not a reading of the guideline.",
    source: "https://developer.apple.com/app-store/review/guidelines/",
  },
  {
    key: "attestations.apple.att-not-required",
    parts: ["attestations", "apple.att-not-required"],
    type: "boolean",
    prompt: "Do you have a reason App Tracking Transparency is not required?",
    explanation: "Set this only when an ads or tracking SDK does not track. Blank stays unchecked.",
    source: "https://developer.apple.com/documentation/apptrackingtransparency",
  },
  {
    key: "attestations.apple.subscription-terms",
    parts: ["attestations", "apple.subscription-terms"],
    type: "boolean",
    prompt: "Does the subscription screen describe what the customer gets for the price?",
    explanation: "Guideline 3.1.2(c). Blank stays unchecked when a purchase SDK is present and the words were not found in source.",
    source: "https://developer.apple.com/app-store/review/guidelines/",
  },
  {
    key: "attestations.apple.listed-sdk-manifests",
    parts: ["attestations", "apple.listed-sdk-manifests"],
    type: "boolean",
    prompt: "Have you seen a privacy manifest for every listed SDK that LaunchyMind does not already cover?",
    explanation: "Say yes only after you opened the file. path_provider stays uncovered unless the lockfile pins path_provider_foundation from 2.3.2 up to but not including 2.6.0.",
    source: "https://developer.apple.com/support/third-party-SDK-requirements/",
  },
  {
    key: "attestations.google.data-safety-form",
    parts: ["attestations", "google.data-safety-form"],
    type: "boolean",
    prompt: "Is the Play Data safety form complete, including SDK data?",
    explanation: "Every Play app must complete the form, except apps that stay on the internal testing track. Play Console was not queried.",
    source: "https://support.google.com/googleplay/android-developer/answer/10787469",
  },
  {
    key: "attestations.google.data-safety-ad-id",
    parts: ["attestations", "google.data-safety-ad-id"],
    type: "boolean",
    prompt: "Does Data safety declare the Android advertising ID as Device or other identifiers?",
    explanation: "Answer this when the app uses ads. Blank stays unchecked.",
    source: "https://support.google.com/googleplay/android-developer/answer/10787469",
  },
  {
    key: "google.account",
    parts: ["google", "account"],
    type: "account",
    prompt: "What kind of Play Console account publishes this app?",
    explanation: "Personal accounts created after 13 November 2023 need a closed test before production. Organization accounts do not. Use organization, personal-before-2023-11-13, or personal-after-2023-11-13.",
    source: "https://support.google.com/googleplay/android-developer/answer/14151465",
  },
  {
    key: "google.distribution",
    parts: ["google", "distribution"],
    type: "distribution",
    prompt: "Which Play track is this build for?",
    explanation: "internal-only skips the Data safety and closed-test rules. Otherwise use production, closed, or open.",
    source: "https://support.google.com/googleplay/android-developer/answer/10787469",
  },
  {
    key: "google.closedTest",
    parts: ["google", "closedTest"],
    type: "boolean",
    prompt: "Has the closed test had at least 12 testers opted in for 14 continuous days?",
    explanation: "Only personal accounts created after 13 November 2023 are asked this before production access.",
    source: "https://support.google.com/googleplay/android-developer/answer/14151465",
  },
  {
    key: "audience.kids",
    parts: ["audience", "kids"],
    type: "boolean",
    prompt: "Is the app made for children?",
    explanation: "The source does not answer this. false means you say it is not a kids app.",
    source: "https://developer.apple.com/app-store/review/guidelines/",
  },
  {
    key: "audience.health",
    parts: ["audience", "health"],
    type: "boolean",
    prompt: "Does the app handle health data?",
    explanation: "Leave blank if you are not sure. LaunchyMind will not guess.",
    source: null,
  },
  {
    key: "audience.userGeneratedContent",
    parts: ["audience", "userGeneratedContent"],
    type: "boolean",
    prompt: "Can users post content that other users see?",
    explanation: "Leave blank if you are not sure.",
    source: null,
  },
  {
    key: "kvkk.explicitConsent",
    parts: ["kvkk", "explicitConsent"],
    type: "boolean",
    prompt: "Is processing based on explicit consent under KVKK?",
    explanation: "false means you say it is not. This is not legal advice.",
    source: null,
  },
  {
    key: "kvkk.consentSeparate",
    parts: ["kvkk", "consentSeparate"],
    type: "boolean",
    prompt: "If explicit consent applies, are the disclosure and the consent separate?",
    explanation: "Set true only when those are separate documents.",
    source: null,
  },
  {
    key: "urls.privacy",
    parts: ["urls", "privacy"],
    type: "url",
    prompt: "Privacy policy URL",
    explanation: "A URL that exists only in a store console can be recorded here. It is not treated as an in-app link.",
    source: null,
  },
  {
    key: "urls.support",
    parts: ["urls", "support"],
    type: "url",
    prompt: "Support URL",
    explanation: "Leave blank to keep the support check unchecked.",
    source: null,
  },
  {
    key: "urls.accountDeletion",
    parts: ["urls", "accountDeletion"],
    type: "url",
    prompt: "Account deletion URL",
    explanation: "The page should name the app or the developer.",
    source: null,
  },
  {
    key: "urls.developerWebsite",
    parts: ["urls", "developerWebsite"],
    type: "url",
    prompt: "Developer website URL",
    explanation: "Used as the site for app-ads.txt when ads are present.",
    source: null,
  },
  {
    key: "appName",
    parts: ["appName"],
    type: "string",
    prompt: "App name, if it is not already in the project",
    explanation: "Blank leaves the name that was read from the project.",
    source: null,
  },
  {
    key: "developerName",
    parts: ["developerName"],
    type: "string",
    prompt: "Developer name",
    explanation: "Used when a deletion page is checked for the app or developer name.",
    source: null,
  },
];

const BY_KEY = new Map(QUESTIONS.map((question) => [question.key, question]));

export interface InitResult {
  path: string;
  wrote: boolean;
  set: string[];
  skipped: string[];
}

export async function initProject(projectPath: string, options: { sets?: string[]; interactive?: boolean }): Promise<InitResult> {
  const path = join(projectPath, ".launchymind", "project.yaml");
  const current = await readCurrent(path);
  const sets = options.sets ?? [];
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const entry of sets) {
    const parsed = parseSet(entry);
    if (parsed.value === undefined) {
      unsetPath(current, parsed.question.parts);
      skipped.push(parsed.question.key);
    } else {
      setPath(current, parsed.question.parts, parsed.value);
      applied.push(parsed.question.key);
    }
  }
  if (options.interactive) {
    if (!stdin.isTTY) throw new Error("init needs a terminal to ask questions. Pass --set key=value for CI, and leave a key out to keep it unchecked.");
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      for (const question of QUESTIONS) {
        if (applied.includes(question.key)) continue;
        stdout.write(`${question.explanation}\n`);
        if (question.source) stdout.write(`${question.source}\n`);
        const answer = (await rl.question(`${question.prompt} [${hint(question)}] `)).trim();
        if (!answer) {
          skipped.push(question.key);
          continue;
        }
        const value = coerce(question, answer);
        setPath(current, question.parts, value);
        applied.push(question.key);
      }
    } finally {
      rl.close();
    }
  }
  const checked = projectSchema.safeParse(current);
  if (!checked.success) {
    throw new Error(`project.yaml would be invalid: ${checked.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  if (applied.length === 0 && sets.length === 0 && !options.interactive) {
    return { path, wrote: false, set: [], skipped: QUESTIONS.map((question) => question.key) };
  }
  await mkdir(dirname(path), { recursive: true });
  const body = stringify(checked.data).trimEnd();
  const header = [
    "# LaunchyMind answers. Omitted keys stay unchecked.",
    "# These are your statements. They are not proof from App Store Connect or Play Console.",
    "",
  ].join("\n");
  await writeFile(path, `${header}${body}\n`, "utf8");
  return { path, wrote: true, set: applied, skipped };
}

async function readCurrent(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return {};
  const parsed = parse(text);
  const checked = projectSchema.safeParse(parsed ?? {});
  if (!checked.success) {
    throw new Error(`${path} is already invalid, so init will not change it: ${checked.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return structuredClone(checked.data) as Record<string, unknown>;
}

function parseSet(entry: string): { question: Question; value: unknown } {
  const index = entry.indexOf("=");
  if (index <= 0) throw new Error(`--set must look like key=value. Received ${entry}`);
  const key = entry.slice(0, index);
  const raw = entry.slice(index + 1);
  const question = BY_KEY.get(key);
  if (!question) throw new Error(`Unknown init key ${key}.`);
  if (raw.trim() === "") return { question, value: undefined };
  return { question, value: coerce(question, raw.trim()) };
}

function coerce(question: Question, raw: string): unknown {
  if (question.type === "boolean") {
    if (/^(true|yes|y)$/i.test(raw)) return true;
    if (/^(false|no|n)$/i.test(raw)) return false;
    throw new Error(`${question.key} must be true or false. Blank leaves it unchecked.`);
  }
  if (question.type === "account") {
    if (raw === "organization" || raw === "personal-before-2023-11-13" || raw === "personal-after-2023-11-13") return raw;
    throw new Error(`${question.key} must be organization, personal-before-2023-11-13, or personal-after-2023-11-13.`);
  }
  if (question.type === "distribution") {
    if (raw === "internal-only" || raw === "production" || raw === "closed" || raw === "open") return raw;
    throw new Error(`${question.key} must be internal-only, production, closed, or open.`);
  }
  if (question.type === "url") {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`${question.key} must be an http or https URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${question.key} must be an http or https URL.`);
    return raw;
  }
  if (!raw.trim()) throw new Error(`${question.key} was blank.`);
  return raw;
}

function hint(question: Question): string {
  if (question.type === "boolean") return "y/n or blank to skip";
  if (question.type === "account") return "organization | personal-before-2023-11-13 | personal-after-2023-11-13 | blank";
  if (question.type === "distribution") return "internal-only | production | closed | open | blank";
  return "blank to skip";
}

function setPath(target: Record<string, unknown>, parts: string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (leaf) cursor[leaf] = value;
}

function unsetPath(target: Record<string, unknown>, parts: string[]): void {
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part) return;
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (leaf) delete cursor[leaf];
}
