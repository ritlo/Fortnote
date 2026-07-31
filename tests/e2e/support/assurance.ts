import type { Browser, BrowserContext, Page } from "@playwright/test";

export interface AssuranceAccount {
  password: string;
  suffix: string;
  username: string;
}

export function uniqueAssuranceAccount(prefix: string): AssuranceAccount {
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    password: `Fortnote-${suffix}-password`,
    suffix,
    username: `${prefix}-${suffix}`
  };
}

export function safeAssuranceCanary(label: string): string {
  return `fortnote-assurance-${label}-${crypto.randomUUID()}`;
}

export async function newAssurancePage(
  browser: Browser,
  baseURL: string | undefined,
  contexts: BrowserContext[]
): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  contexts.push(context);
  return context.newPage();
}

export async function closeAssuranceContexts(contexts: BrowserContext[]): Promise<void> {
  await Promise.all(contexts.splice(0).map(async (context) => context.close()));
}
