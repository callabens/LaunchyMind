import { LAWYER_WARNING, type LaunchReport } from "../../core/src/index.ts";

export interface FixProposal {
  ruleId: string;
  writesFiles: false;
  available: boolean;
  warning: string | null;
  summary: string;
  draft: string;
}

const DRAFTS: Record<string, { warning: string | null; summary: string; draft: string }> = {
  "purpose-string": {
    warning: null,
    summary: "Draft an iOS purpose string. Nothing is written until a later version supports approved edits.",
    draft: [
      "Add a non-empty usage description to ios/Runner/Info.plist.",
      "NSCameraUsageDescription example:",
      "  This app uses the camera so you can attach a photo you choose.",
      "Describe the real feature. Do not use a placeholder.",
    ].join("\n"),
  },
  "privacy-manifest": {
    warning: null,
    summary: "Draft a PrivacyInfo.xcprivacy skeleton. Confirm the reason codes against Apple's current list before shipping.",
    draft: [
      "Create ios/Runner/PrivacyInfo.xcprivacy and declare only APIs the app or its SDKs actually use.",
      "Each NSPrivacyAccessedAPIType needs one or more approved reason codes.",
      "This preview does not choose a reason code for you.",
    ].join("\n"),
  },
  "privacy-policy": {
    warning: LAWYER_WARNING,
    summary: "Draft a starting privacy page. It is not a finished policy.",
    draft: [
      LAWYER_WARNING,
      "",
      "Include, in plain language:",
      "- who the data controller is and how to contact them",
      "- what is collected, why, and the method",
      "- who it is shared with",
      "- the legal basis",
      "- how long it is kept and how to delete it",
      "- how to withdraw consent where consent is the basis",
      "- the person's rights",
      "If the app shows ads or uses tracking SDKs, say so.",
      "KVKK notice and explicit consent, when consent is required, should be separate texts.",
    ].join("\n"),
  },
  "account-deletion": {
    warning: LAWYER_WARNING,
    summary: "Draft an in-app deletion path and a web deletion page. Nothing is written.",
    draft: [
      "In the app, add a visible account deletion action (for example on the account screen).",
      "Also publish a web page where someone can request deletion without reinstalling the app.",
      "The page should name the app or the developer and should not be a placeholder.",
      "Say what is deleted, what may be kept, and why.",
    ].join("\n"),
  },
  "app-ads": {
    warning: null,
    summary: "Draft the location of app-ads.txt. Seller lines must come from the ad networks you use.",
    draft: [
      "Publish app-ads.txt at the root of the developer website:",
      "  https://<developer-domain>/app-ads.txt",
      "Do not invent seller IDs. Copy them from each ad network's dashboard.",
      "IAB Tech Lab ads.txt 1.1 also documents OWNERDOMAIN and MANAGERDOMAIN.",
    ].join("\n"),
  },
};

export function proposeFix(report: LaunchReport, ruleId: string): FixProposal {
  const finding = report.findings.find((item) => item.ruleId === ruleId);
  const key = finding?.fix ?? null;
  const draft = key ? DRAFTS[key] : undefined;
  if (!finding || !draft) {
    return {
      ruleId,
      writesFiles: false,
      available: false,
      warning: null,
      summary: finding
        ? "This rule has no draft in this preview."
        : "That rule was not in the scan. Run a scan and use a rule id from the findings.",
      draft: "",
    };
  }
  return {
    ruleId,
    writesFiles: false,
    available: true,
    warning: draft.warning,
    summary: draft.summary,
    draft: draft.draft,
  };
}

export function applyFix(approved: boolean, allowApply: boolean): { status: "BLOCKED" | "NOT_IMPLEMENTED"; reason: string; writesFiles: false } {
  if (!allowApply) {
    return {
      status: "BLOCKED",
      writesFiles: false,
      reason: "apply_fix is off. Start the tool with LAUNCHYMIND_ALLOW_APPLY=1. This preview still does not write files.",
    };
  }
  if (!approved) {
    return {
      status: "BLOCKED",
      writesFiles: false,
      reason: "Refusing to apply a fix without an explicit approval flag. No file was changed.",
    };
  }
  return {
    status: "NOT_IMPLEMENTED",
    writesFiles: false,
    reason: "Approved apply is not implemented in this preview (planned for phase 5). No file was changed.",
  };
}
