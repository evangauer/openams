// The optional sign-in email: the link it carries, what it says, and when it is off.
// Every address here is fictional.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appSignInLink,
  signInEmailContent,
  signInMailFromEnv,
} from "../dist/firebase/sign-in-mail.js";

const origin = "https://ams.fixture.example";
const firebaseLink =
  "https://fixture-project.firebaseapp.com/__/auth/action?apiKey=fixture-key&mode=signIn&oobCode=ONE-TIME-CODE&continueUrl=https%3A%2F%2Fams.fixture.example%2Fsign-in%2Ffinish&lang=en&tenantId=fixture-tenant";

test("the link goes straight to the app's finish page with the same one-time code", () => {
  const link = new URL(appSignInLink(firebaseLink, origin));
  assert.equal(link.origin, origin);
  assert.equal(link.pathname, "/sign-in/finish");
  assert.equal(link.searchParams.get("mode"), "signIn");
  assert.equal(link.searchParams.get("oobCode"), "ONE-TIME-CODE");
  assert.equal(link.searchParams.get("apiKey"), "fixture-key");
  assert.equal(link.searchParams.get("tenantId"), "fixture-tenant");
  assert.equal(link.searchParams.get("lang"), "en");
  // Firebase's own handler and its redirect target are dropped.
  assert.equal(link.searchParams.has("continueUrl"), false);
  assert.doesNotMatch(link.toString(), /firebaseapp\.com/);
  assert.equal(link.searchParams.has("phone"), false);
  assert.equal(new URL(appSignInLink(firebaseLink, origin, true)).searchParams.get("phone"), "add");
});

test("the Auth emulator's links are rewritten the same way, without a tenant", () => {
  const emulated =
    "http://127.0.0.1:9099/emulator/action?mode=signIn&lang=en&oobCode=EMULATED&apiKey=fake-api-key&continueUrl=http%3A%2F%2Flocalhost%3A4500%2Fsign-in%2Ffinish";
  assert.equal(
    appSignInLink(emulated, "http://localhost:4500"),
    "http://localhost:4500/sign-in/finish?mode=signIn&oobCode=EMULATED&apiKey=fake-api-key&lang=en",
  );
});

test("anything but a complete sign-in link is refused", () => {
  for (const bad of [
    firebaseLink.replace("mode=signIn", "mode=resetPassword"),
    firebaseLink.replace("oobCode=ONE-TIME-CODE&", ""),
    firebaseLink.replace("apiKey=fixture-key&", ""),
  ])
    assert.throws(() => appSignInLink(bad, origin), /unexpected sign-in link/);
});

test("the email names the address, carries one link and says what to do if unexpected", () => {
  const link = appSignInLink(firebaseLink, origin);
  const { subject, text, html } = signInEmailContent({ to: "casey@harbor-test.example", link }, origin);
  assert.equal(subject, "Your OpenAMS sign-in link");
  assert.match(text, /sign in as casey@harbor-test\.example/);
  assert.ok(text.includes(link));
  assert.match(text, /Didn't ask for this\? You can ignore this email\./);
  assert.match(text, /Someone asked to sign in to ams\.fixture\.example/);
  // The button and the written-out link are the same app link; images come from the app.
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1].replaceAll("&#38;", "&"));
  assert.deepEqual(hrefs, [link, link]);
  const images = [...html.matchAll(/src="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(images, [`${origin}/brand/email/scene-band.png`, `${origin}/brand/email/openams-lockup.png`]);
  assert.match(html, /alt="OpenAMS"/);
  assert.doesNotMatch(html, /firebaseapp\.com/);
});

test("addresses and links are escaped in the HTML", () => {
  const { html } = signInEmailContent(
    { to: '"><img src=x onerror=alert(1)>@fixture.example', link: `${origin}/sign-in/finish?mode=signIn&oobCode="><b>` },
    origin,
  );
  // Only escaped text gets through: no tag or attribute breaks out of its place.
  assert.doesNotMatch(html, /<img src=x|"><img|"><b>|<b>/);
  assert.match(html, /&#34;&#62;&#60;img src=x onerror=alert\(1\)&#62;@fixture\.example/);
});

test("sign-in mail is off unless the SMTP address, the sender and the app's origin are all set", () => {
  const smtp = { AMS_SMTP_URL: "smtps://u:p@smtp.fixture.example:465", AMS_MAIL_FROM: "OpenAMS <no-reply@fixture.example>" };
  assert.equal(signInMailFromEnv({}, origin), undefined);
  assert.equal(signInMailFromEnv({ AMS_SMTP_URL: smtp.AMS_SMTP_URL }, origin), undefined);
  assert.equal(signInMailFromEnv({ AMS_MAIL_FROM: smtp.AMS_MAIL_FROM }, origin), undefined);
  assert.equal(signInMailFromEnv(smtp, undefined), undefined);
  assert.equal(typeof signInMailFromEnv(smtp, origin), "function");
  assert.throws(() => signInMailFromEnv({ ...smtp, AMS_SMTP_URL: "https://smtp.fixture.example" }, origin), /AMS_SMTP_URL/);
});
