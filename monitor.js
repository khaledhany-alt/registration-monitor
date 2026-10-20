import { chromium } from 'playwright-core';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(ROOT, 'runs');
const OUTBOX_DIR = path.join(RUNS_DIR, 'outbox');
const ACCOUNTS_FILE = path.join(RUNS_DIR, 'accounts.csv');

const FORM = 'form#SiteAddForm[action*="register"]';

const BRANDS = {
    daftra: {
        label: 'Daftra',
        url: process.env.DAFTRA_REGISTER_URL || 'https://www.daftra.com/en/register',
    },
    enerpize: {
        label: 'Enerpize',
        url: process.env.ENERPIZE_REGISTER_URL || 'https://www.enerpize.com/register',
    },
};

// Failures before the form is submitted never create an account, so they are
// safe to retry once. That keeps a slow page load from showing as an outage.
const RETRYABLE_STAGES = new Set(['load', 'fill']);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const dryRun = flag('dry-run');
const headed = flag('headed');

const config = {
    emailTemplate: process.env.SIGNUP_EMAIL_TEMPLATE || '',
    dialCode: process.env.SIGNUP_DIAL_CODE || '+20',
    phone: (process.env.SIGNUP_PHONE || '').replace(/\D/g, '').replace(/^0+/, ''),
    password: process.env.SIGNUP_PASSWORD || '',
    businessName: process.env.SIGNUP_BUSINESS_NAME || 'Registration Monitor',
    // Without a system Chrome, Playwright's own Chromium is used (cloud-run.sh installs it).
    chromePath: process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined),
    timeoutMs: Number(process.env.SIGNUP_TIMEOUT_SECONDS || 120) * 1000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const now = () => new Date().toLocaleString('sv-SE');
const log = (message) => console.log(`[${now()}] ${message}`);

function configErrors() {
    const errors = [];
    if (!config.emailTemplate.includes('{stamp}')) {
        errors.push('SIGNUP_EMAIL_TEMPLATE must contain {stamp} so every run uses a new email');
    }
    if (!config.phone) {
        errors.push('SIGNUP_PHONE is required (national number, e.g. 1001234567)');
    }
    return errors;
}

function newAccount(key) {
    const stamp = Date.now().toString(36);
    return {
        sub: `regmon${key[0]}${stamp}`,
        email: config.emailTemplate.replaceAll('{brand}', key).replaceAll('{stamp}', stamp),
        password: config.password || `Rm${randomBytes(9).toString('base64url')}7`,
        businessName: `${config.businessName} ${stamp}`,
    };
}

async function waitForAjax(page) {
    await page.waitForFunction(() => !window.jQuery || window.jQuery.active === 0);
}

async function validationError(page, input) {
    const handle = await input.elementHandle();
    await page.waitForFunction(
        (el) => !el.classList.contains('pending')
            && (el.classList.contains('has-success') || el.classList.contains('has-error')),
        handle,
    );
    return input.evaluate((el) => (el.classList.contains('has-error')
        ? String(window.jQuery(el.form).validate().errorMap[el.name] || 'invalid value')
        : null));
}

async function visibleErrors(page) {
    return page.evaluate(() => {
        const selectors = '#flashMessage, .Errormessage, .alert-danger, .error-message, #recaptcha_error';
        const texts = [...document.querySelectorAll(selectors)]
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        return [...new Set(texts)].join(' | ');
    });
}

async function fillForm(page, account) {
    const form = page.locator(FORM);
    const field = (name) => form.locator(`[name="data[Site][${name}]"]`);

    await field('business_name').fill(account.businessName);
    await field('business_name').blur();
    await waitForAjax(page);

    await field('email').fill(account.email);
    await field('email').blur();
    const emailError = await validationError(page, field('email'));
    if (emailError) throw new Error(`Email rejected: ${emailError}`);
    await waitForAjax(page);

    // Filled after the email because the page suggests a login URL from it.
    await field('sub').fill(account.sub);
    await field('sub').blur();
    const subError = await validationError(page, field('sub'));
    if (subError) throw new Error(`Login URL rejected: ${subError}`);
    await waitForAjax(page);

    const dialCode = await field('countryCode').evaluate((select, dial) => {
        if (select.selectize) {
            select.selectize.setValue(dial);
        } else {
            select.value = dial;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return select.value;
    }, config.dialCode);
    if (dialCode !== config.dialCode) {
        throw new Error(`Dial code ${config.dialCode} is not in the country list`);
    }

    await field('phone2').fill(config.phone);
    await field('phone2').blur();

    await field('password').fill(account.password);
    await field('password').blur();

    // Only shown for Saudi numbers; tick it when a real user would see it.
    const agree = field('agree_terms');
    if (await agree.isVisible()) await agree.check({ force: true });

    await waitForAjax(page);
    const errors = await page.evaluate((selector) => {
        const $form = window.jQuery(selector);
        const validator = $form.validate();
        $form.valid();
        return validator.errorList.map((e) => `${e.element.name.replace(/^data\[Site\]\[|\]$/g, '')}: ${e.message}`);
    }, FORM);
    if (errors.length) throw new Error(`Form validation failed: ${errors.join('; ')}`);
}

async function reasonFormDidNotSubmit(page) {
    const shown = await visibleErrors(page);
    if (shown) return `The form did not submit: ${shown}`;
    const captcha = await page.evaluate(() => ({
        expected: !!document.querySelector('script[src*="recaptcha/enterprise.js"]'),
        loaded: !!window.grecaptcha?.enterprise?.execute,
    }));
    if (captcha.expected && !captcha.loaded) return 'The form did not submit: the reCAPTCHA script never loaded';
    if (captcha.expected) return `The form did not submit within ${seconds(config.timeoutMs)}: reCAPTCHA never returned a token`;
    return `The form did not submit within ${seconds(config.timeoutMs)}`;
}

async function submitForm(page) {
    // Tracking and reCAPTCHA iframes post documents too; only the page's own form counts.
    const post = page.waitForResponse(
        (response) => response.request().method() === 'POST'
            && response.frame() === page.mainFrame()
            && new URL(response.url()).pathname.endsWith('/register'),
        { timeout: config.timeoutMs },
    );
    // The click waits for the navigation it starts, and creating the account can take over 30s.
    const click = page.locator(`${FORM} button[type="submit"]`).click({ timeout: config.timeoutMs });

    let response;
    try {
        [response] = await Promise.all([post, click]);
    } catch {
        throw new Error(await reasonFormDidNotSubmit(page));
    }

    const status = response.status();
    const location = response.headers().location || '';
    if (status >= 300 && status < 400) {
        if (location.includes('/owners/firstlogin')) return;
        if (location.includes('verify_otp')) {
            throw new Error(`Signup asked for an SMS OTP, which the monitor can't complete (dial code ${config.dialCode})`);
        }
        await page.waitForLoadState('load').catch(() => {});
        const shown = await visibleErrors(page);
        throw new Error(`Signup redirected to ${location}${shown ? `: ${shown}` : ''}`);
    }

    await page.waitForLoadState('load').catch(() => {});
    if (status >= 400) throw new Error(`Signup returned HTTP ${status}`);
    throw new Error(`Signup was rejected: ${(await visibleErrors(page)) || 'the form came back with no error message'}`);
}

async function openNewAccount(page, account) {
    let lastStatus = 0;
    page.on('response', (response) => {
        if (response.request().resourceType() === 'document' && new URL(response.url()).hostname.startsWith(`${account.sub}.`)) {
            lastStatus = response.status();
        }
    });

    await page.waitForURL(
        (url) => url.hostname.startsWith(`${account.sub}.`) && !url.pathname.includes('/owners/firstlogin'),
        { timeout: config.timeoutMs, waitUntil: 'domcontentloaded' },
    );
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
    // The tenant redirects with JavaScript after load, so let it settle before judging.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    const url = new URL(page.url());
    if (url.pathname.includes('login') || await page.locator('form[action*="login"]').count()) {
        throw new Error(`The account was created but the owner wasn't signed in: it landed on the login page (${url.pathname})`);
    }
    if (lastStatus >= 400) {
        throw new Error(`The account was created but ${url.pathname} returned HTTP ${lastStatus}`);
    }
    return url.href;
}

async function saveEvidence(page, key) {
    const file = path.join(RUNS_DIR, `${now().replace(/[: ]/g, '-')}-${key}`);
    try {
        await page.screenshot({ path: `${file}.png`, fullPage: true, timeout: 15_000 });
        await writeFile(`${file}.html`, await page.content());
        return `${file}.png`;
    } catch {
        return null;
    }
}

function userAgent(browser) {
    const major = browser.version().split('.')[0];
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function register(browser, key) {
    const brand = BRANDS[key];
    const account = newAccount(key);
    const result = { key, label: brand.label, account, stage: 'load', ok: false };
    const started = Date.now();

    const context = await browser.newContext({
        userAgent: userAgent(browser),
        locale: 'en-US',
        viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    // Every page the browser lands on, without query strings so the sign-in token stays out of logs.
    result.trail = [];
    page.on('response', (response) => {
        const request = response.request();
        if (request.isNavigationRequest() && response.frame() === page.mainFrame()) {
            const url = new URL(response.url());
            result.trail.push(`${request.method()} ${response.status()} ${url.host}${url.pathname}`);
        }
    });

    try {
        const response = await page.goto(brand.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        if (!response || response.status() >= 400) {
            throw new Error(`The signup page returned HTTP ${response ? response.status() : 'nothing'}`);
        }
        await page.locator(FORM).waitFor();
        await page.waitForFunction((selector) => window.jQuery?.(selector).data('validator'), FORM);

        result.stage = 'fill';
        await fillForm(page, account);

        if (dryRun) {
            const captcha = await page.evaluate(() => !!document.querySelector('script[src*="recaptcha/enterprise.js"]'));
            if (captcha) await page.waitForFunction(() => window.grecaptcha?.enterprise?.execute, null, { timeout: 20_000 });
            result.ok = true;
            result.note = `form filled and valid, not submitted (${captcha ? 'reCAPTCHA loaded' : 'no reCAPTCHA on the page'})`;
            return result;
        }

        result.stage = 'submit';
        await submitForm(page);

        result.stage = 'open account';
        result.finalUrl = await openNewAccount(page, account);
        result.ok = true;
    } catch (error) {
        result.error = String(error.message || error).split('\n')[0].slice(0, 500);
        result.screenshot = await saveEvidence(page, key);
    } finally {
        result.finishedAt = Date.now();
        result.durationMs = result.finishedAt - started;
        await context.close();
    }
    return result;
}

async function check(browser, key) {
    let result = await register(browser, key);
    if (!result.ok && !dryRun && RETRYABLE_STAGES.has(result.stage)) {
        log(`${result.label}: failed at ${result.stage} (${result.error}), retrying in 30s`);
        await sleep(30_000);
        result = { ...(await register(browser, key)), retried: true };
    }
    return result;
}

function accountCreated(result) {
    return result.ok || result.stage === 'open account';
}

async function recordAccount(result) {
    if (!(accountCreated(result) || result.stage === 'submit')) return;
    const row = [now(), result.key, result.ok ? 'ok' : `failed at ${result.stage}`, result.account.email, result.account.sub];
    await appendFile(ACCOUNTS_FILE, `${row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',')}\n`);
}

// One file per check, in the shape the Registration Monitor page reads from its "checks" collection.
async function writeOutbox(result) {
    const at = new Date(result.finishedAt).toISOString().replace(/\.\d+Z$/, 'Z');
    const domain = new URL(BRANDS[result.key].url).hostname.replace(/^www\./, '');
    const record = {
        brand: result.key,
        at,
        ok: result.ok,
        stage: result.stage,
        error: result.error || null,
        durationMs: result.durationMs,
        retried: Boolean(result.retried),
        accountHost: accountCreated(result) ? `${result.account.sub}.${domain}` : null,
        trail: result.trail,
    };
    const file = path.join(OUTBOX_DIR, `${at.replace(/[-:]/g, '')}-${result.key}.json`);
    await writeFile(file, `${JSON.stringify(record)}\n`);
    return file;
}

async function main() {
    const errors = configErrors();
    if (errors.length) {
        errors.forEach((e) => console.error(`Config: ${e}`));
        return 2;
    }

    const only = option('brand');
    const keys = only ? only.split(',') : Object.keys(BRANDS);
    const unknown = keys.filter((k) => !BRANDS[k]);
    if (unknown.length) {
        console.error(`Unknown brand: ${unknown.join(', ')} (use ${Object.keys(BRANDS).join(', ')})`);
        return 2;
    }

    await mkdir(OUTBOX_DIR, { recursive: true });

    let browser;
    try {
        browser = await chromium.launch({ executablePath: config.chromePath, headless: !headed });
    } catch (error) {
        console.error(`Couldn't start Chrome: ${String(error.message).split('\n')[0]}`);
        return 2;
    }

    let results;
    try {
        results = await Promise.all(keys.map((key) => check(browser, key)));
    } finally {
        await browser.close();
    }

    for (const r of results) {
        if (r.ok) log(`${r.label}: OK in ${seconds(r.durationMs)} → ${r.finalUrl || r.note}${dryRun ? '' : `\n    pages: ${r.trail.join(' → ')}`}`);
        else log(`${r.label}: FAILED at ${r.stage} after ${seconds(r.durationMs)}: ${r.error}${r.screenshot ? ` (${r.screenshot})` : ''}\n    pages: ${r.trail.join(' → ')}`);
        if (!dryRun) {
            await recordAccount(r);
            log(`    saved ${path.relative(ROOT, await writeOutbox(r))}`);
        }
    }

    return results.every((r) => r.ok) ? 0 : 1;
}

main().then(
    (code) => process.exit(code),
    (error) => {
        console.error(error);
        process.exit(2);
    },
);
