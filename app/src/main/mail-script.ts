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
  if (req.op === 'draft') {
    var d = mail.OutgoingMessage({ subject: req.subject, content: req.body, visible: false });
    mail.outgoingMessages.push(d);
    for (var i = 0; i < req.to.length; i++) d.toRecipients.push(mail.ToRecipient({ address: req.to[i] }));
    mail.save(d);
    return JSON.stringify({ draftId: d.id(), saved: true, sent: false });
  }
  throw new Error('Unknown Mail operation.');
}
`
