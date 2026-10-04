/** Fixed JXA program. User input is JSON data in argv, never executable source. */
export const MAIL_SCRIPT = String.raw`
function run(argv) {
  var req = JSON.parse(argv[0]);
  var mail = Application('com.apple.mail');
  function clip(s, n) { return String(s || '').slice(0, n); }
  function account(id) {
    var a = mail.accounts.byId(id);
    if (!a.exists()) throw new Error('Account no longer exists. Run mail_accounts again.');
    return a;
  }
  function box(id, path) {
    var b = account(id);
    for (var i = 0; i < path.length; i++) b = b.mailboxes.byName(path[i]);
    if (!b.exists()) throw new Error('Mailbox no longer exists. Run mail_accounts again.');
    return b;
  }
  function locator(m) {
    var b = m.mailbox(), path = [], aid = b.account().id();
    for (var i = 0; i < 20 && b; i++) {
      path.unshift(b.name());
      try { b = b.container(); if (!b || !b.exists()) break; } catch (_) { break; }
    }
    // Mail's synthetic account container is not part of the mailbox path.
    // Verify the message too: a real folder can have the account's name.
    var id = m.id();
    function containsMessage(p) {
      try { return box(aid, p).messages.byId(id).exists(); } catch (_) { return false; }
    }
    if (!containsMessage(path)) {
      if (path.length > 1 && path[0] === account(aid).name()) path.shift();
      if (!containsMessage(path)) throw new Error('Message moved or removed. Search again.');
    }
    return { accountId: aid, mailboxPath: path, messageId: id };
  }

  function summary(m) {
    return { locator: locator(m), subject: clip(m.subject(), 1000), sender: clip(m.sender(), 1000),
      date: m.dateReceived().toISOString(), unread: !m.readStatus() };
  }
  if (req.op === 'connect') return JSON.stringify({ accountCount: mail.accounts.length });
  if (req.op === 'accounts') {
    var result = [], remaining = 500, truncated = false;
    function paths(parent, prefix, out) {
      if (prefix.length >= 20) { truncated = true; return; }
      var boxes = parent.mailboxes;
      for (var i = 0; i < boxes.length; i++) {
        if (--remaining < 0) { truncated = true; return; }
        var b = boxes[i], p = prefix.concat([b.name()]);
        out.push(p); paths(b, p, out);
      }
    }
    for (var i = 0; i < Math.min(mail.accounts.length, 50); i++) {
      var a = mail.accounts[i], p = [];
      paths(a, [], p);
      result.push({ id: a.id(), name: clip(a.name(), 1000), emails: a.emailAddresses(), mailboxPaths: p });
    }
    return JSON.stringify({ accounts: result, truncated: truncated || mail.accounts.length > 50 });
  }
  if (req.op === 'search') {
    var b = req.accountId ? box(req.accountId, req.mailboxPath) : mail.inbox;
    var conditions = [];
    if (req.query) conditions.push({ _or: [{ subject: { _contains: req.query } }, { sender: { _contains: req.query } }] });
    if (req.unreadOnly) conditions.push({ readStatus: false });
    var messages = conditions.length ? b.messages.whose(conditions.length === 1 ? conditions[0] : { _and: conditions }) : b.messages;
    var total = messages.length, end = Math.min(total, req.offset + req.limit), found = [];
    // Resolve filtered results by ID before reading fields: otherwise Mail
    // repeats the full whose query for every property in the summary.
    for (var i = req.offset; i < end; i++) found.push(summary(b.messages.byId(messages[i].id())));
    return JSON.stringify({ messages: found, nextOffset: end < total ? end : null,
      scope: req.accountId ? req.mailboxPath : 'All inboxes', order: 'Mail mailbox order' });
  }
  if (req.op === 'read') {
    var m = box(req.accountId, req.mailboxPath).messages.byId(req.messageId);
    if (!m.exists()) throw new Error('Message moved or removed. Search again.');
    var result = summary(m), body = String(m.content());
    result.body = body.slice(0, req.maxChars);
    result.truncated = body.length > req.maxChars;
    return JSON.stringify(result);
  }
  throw new Error('Unknown Mail operation.');
}
`

/**
 * Fixed AppleScript that writes a message, for drafts and sends. AppleScript
 * rather than JXA because only AppleScript's Mail dictionary attaches a file
 * and sets an HTML body: the JXA forms fail with "Can't get object". Input
 * arrives as argv strings, never as source: op, subject, plain body, HTML
 * body, and newline-separated to, cc, bcc and attachment paths. The HTML is
 * set before the attachments, which setting it would otherwise replace.
 */
export const COMPOSE_SCRIPT = String.raw`
on splitLines(t)
	if t is "" then return {}
	set AppleScript's text item delimiters to linefeed
	set out to text items of t
	set AppleScript's text item delimiters to ""
	return out
end splitLines
on run argv
	set op to item 1 of argv
	set subj to item 2 of argv
	set plainBody to item 3 of argv
	set htmlBody to item 4 of argv
	set toList to my splitLines(item 5 of argv)
	set ccList to my splitLines(item 6 of argv)
	set bccList to my splitLines(item 7 of argv)
	set filePaths to my splitLines(item 8 of argv)
	tell application "Mail"
		set m to make new outgoing message with properties {subject:subj, content:plainBody, visible:false}
		repeat with a in toList
			make new to recipient at end of to recipients of m with properties {address:(a as text)}
		end repeat
		repeat with a in ccList
			make new cc recipient at end of cc recipients of m with properties {address:(a as text)}
		end repeat
		repeat with a in bccList
			make new bcc recipient at end of bcc recipients of m with properties {address:(a as text)}
		end repeat
		if htmlBody is not "" then set html content of m to htmlBody
		repeat with f in filePaths
			tell content of m to make new attachment with properties {file name:((POSIX file (f as text)) as alias)} at after last paragraph
		end repeat
		-- Attachments are added asynchronously.
		if (count of filePaths) > 0 then delay 2
		if op is "send" then
			if not (send m) then error "Mail did not send the message."
			return "{\"sent\":true,\"attachments\":" & (count of filePaths) & "}"
		end if
		save m
		return "{\"saved\":true,\"sent\":false,\"attachments\":" & (count of filePaths) & "}"
	end tell
end run
`
