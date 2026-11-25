// The optional invitation email: what it says, what it refuses to carry, and when it is
// off. Everyone and every agency here is fictional.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  invitationContent,
  invitationMailFromEnv,
  mailSafeName,
} from "../dist/firebase/invitation-mail.js";

const mailModule = new URL("../dist/firebase/invitation-mail.js", import.meta.url).href;

const message = {
  to: "morgan@harbor-test.example",
  agencyName: "Harbor Test Agency",
  invitedByEmail: "avery@harbor-test.example",
  role: "member",
  expiresAt: new Date("2026-12-01T12:00:00Z"),
  invitationId: "AbCdEfGhIjKlMnOpQrStUvWx",
  token: "s".repeat(43),
};
const LINK = `https://ams.fixture.example/join#i=AbCdEfGhIjKlMnOpQrStUvWx&t=${"s".repeat(43)}`;

test("the invitation names the agency, inviter, role, address and expiry, and links to its join page", () => {
  const { subject, text, html } = invitationContent(message, "https://ams.fixture.example");
  assert.equal(subject, "You've been invited to join an agency on OpenAMS");
  assert.match(text, /avery@harbor-test\.example invited you to join Harbor Test Agency on OpenAMS as a member\./);
  assert.match(text, /open this link and sign in with this email address\n\(morgan@harbor-test\.example\)/);
  assert.ok(text.split("\n").includes(LINK));
  assert.match(text, /^The invitation is open until December 1, 2026 \(UTC\)\.$/m);
  assert.match(html, />The invitation is open until December 1, 2026 \(UTC\)\.</);
  assert.doesNotMatch(text + html, /2026-12-01/);
  assert.match(html, /<strong[^>]*>Harbor Test Agency<\/strong>/);
  // Every link is the app's own origin: the logo's home page, and the join page with the
  // invitation and its secret after "#", which browsers never send to a server.
  const hrefs = new Set(html.match(/href="[^"]*"/g));
  assert.ok(hrefs.has(`href="${LINK.replaceAll("&", "&#38;")}"`), [...hrefs].join(" "));
  for (const href of hrefs) {
    const url = new URL(href.slice(6, -1).replaceAll("&#38;", "&"));
    assert.equal(url.origin, "https://ams.fixture.example");
    assert.equal(url.search, "", "nothing in the query string");
  }
  assert.doesNotMatch(text + html, /[?](token|invitation|oobCode|t|i)=/i);
});

// Each zone gets its own process, because a server's time zone is fixed when it starts.
// Kiritimati is fourteen hours ahead of UTC and Pago Pago eleven behind, so both put the
// server's own clock on a different calendar day for one of the two instants.
test("the expiry is the UTC calendar day, whatever the server's time zone", () => {
  const instants = ["2026-12-01T00:30:00Z", "2026-12-01T23:30:00Z"];
  const script = `
    import { invitationContent } from ${JSON.stringify(mailModule)};
    const message = ${JSON.stringify(message)};
    console.log(JSON.stringify(${JSON.stringify(instants)}.map((instant) => {
      const expiresAt = new Date(instant);
      const { text, html } = invitationContent({ ...message, expiresAt }, "https://ams.fixture.example");
      return { serverDay: expiresAt.getDate(), text, html };
    })));`;
  const sentence = "The invitation is open until December 1, 2026 (UTC).";
  for (const [zone, serverDays] of [["Pacific/Kiritimati", [1, 2]], ["Pacific/Pago_Pago", [30, 1]], ["UTC", [1, 1]]]) {
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8",
    });
    const results = JSON.parse(output);
    assert.deepEqual(results.map((result) => result.serverDay), serverDays, zone);
    for (const { text, html } of results) {
      assert.ok(text.split("\n").includes(sentence), `${zone}: ${text}`);
      assert.ok(html.includes(`>${sentence}<`), `${zone} (HTML)`);
    }
  }
});

test("an agency's name can't smuggle links or markup into the message", () => {
  assert.equal(mailSafeName("Harbor & Pine  Agency"), "Harbor & Pine Agency");
  assert.equal(mailSafeName("Win a prize at https://bad.example/x now"), "Win a prize at now");
  assert.equal(mailSafeName("Visit www.bad.example today"), "Visit today");
  assert.equal(mailSafeName("bad.example/login"), "An agency");
  assert.equal(mailSafeName("Line one\r\nBcc: someone@bad.example"), "Line one Bcc:");
  assert.equal(mailSafeName("x".repeat(200)).length, 80);
  assert.equal(mailSafeName("   "), "An agency");
  const { html } = invitationContent({ ...message, agencyName: '<img src=x onerror="alert(1)">' }, "https://ams.fixture.example");
  // The layout's own images are fine; the agency's markup must not get through.
  assert.doesNotMatch(html, /<img src=x|onerror="/);
});

test("mail is off unless the SMTP address, the sender and the app's origin are all set", () => {
  const origin = "https://ams.fixture.example";
  assert.equal(invitationMailFromEnv({}, origin), undefined);
  assert.equal(invitationMailFromEnv({ AMS_SMTP_URL: "smtps://u:p@smtp.fixture.example:465" }, origin), undefined);
  assert.equal(invitationMailFromEnv({ AMS_MAIL_FROM: "OpenAMS <no-reply@fixture.example>" }, origin), undefined);
  assert.equal(
    invitationMailFromEnv({ AMS_SMTP_URL: "smtps://u:p@smtp.fixture.example:465", AMS_MAIL_FROM: "OpenAMS <no-reply@fixture.example>" }, undefined),
    undefined,
  );
  assert.equal(
    typeof invitationMailFromEnv({ AMS_SMTP_URL: "smtps://u:p@smtp.fixture.example:465", AMS_MAIL_FROM: "OpenAMS <no-reply@fixture.example>" }, origin),
    "function",
  );
  assert.throws(() => invitationMailFromEnv({ AMS_SMTP_URL: "https://smtp.fixture.example", AMS_MAIL_FROM: "a@fixture.example" }, origin), /AMS_SMTP_URL/);
});

// Exercise the installed SMTP client against a local receiver. No mail leaves this
// process, and the rejection case must reach the caller instead of claiming success.
async function smtpReceiver(t, rejectRecipient = false) {
  const commands = [];
  const messages = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 fixture.example ESMTP\r\n");
    let pending = "";
    let data;
    socket.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\r\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data) {
          if (line === ".") {
            messages.push(data.join("\r\n"));
            data = undefined;
            socket.write("250 Accepted\r\n");
          } else data.push(line);
          continue;
        }
        commands.push(line);
        if (/^(EHLO|HELO) /i.test(line)) socket.write("250 fixture.example\r\n");
        else if (/^MAIL FROM:/i.test(line)) socket.write("250 Sender accepted\r\n");
        else if (/^RCPT TO:/i.test(line)) socket.write(rejectRecipient ? "550 Recipient rejected\r\n" : "250 Recipient accepted\r\n");
        else if (line === "DATA") { data = []; socket.write("354 Send message\r\n"); }
        else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("502 Unsupported command\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { commands, messages, url: `smtp://127.0.0.1:${server.address().port}?ignoreTLS=true` };
}

test("the configured mailer sends one invitation through SMTP", { timeout: 5000 }, async (t) => {
  const receiver = await smtpReceiver(t);
  const send = invitationMailFromEnv({ AMS_SMTP_URL: receiver.url, AMS_MAIL_FROM: "OpenAMS <no-reply@fixture.example>" }, "https://ams.fixture.example");
  await send(message);
  assert.deepEqual(receiver.commands.filter((line) => /^RCPT TO:/i.test(line)), ["RCPT TO:<morgan@harbor-test.example>"]);
  assert.equal(receiver.messages.length, 1);
  assert.match(receiver.messages[0], /Subject: You've been invited to join an agency on OpenAMS/);
  assert.match(receiver.messages[0], /Harbor Test Agency/);
  assert.doesNotMatch(receiver.messages[0], /[?](token|invitation|oobCode|t|i)=/i);
});

test("an SMTP rejection is reported as a failed invitation send", { timeout: 5000 }, async (t) => {
  const receiver = await smtpReceiver(t, true);
  const send = invitationMailFromEnv({ AMS_SMTP_URL: receiver.url, AMS_MAIL_FROM: "OpenAMS <no-reply@fixture.example>" }, "https://ams.fixture.example");
  await assert.rejects(send(message), (error) => error.code === "EENVELOPE" && error.responseCode === 550);
  assert.equal(receiver.messages.length, 0);
});
