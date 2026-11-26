# Superagent 2.1.3-beta.42

**Email drafts land in the account you mean.** `mail_draft` and `mail_send` take a from address, so a draft for your work address is saved in that account's Drafts instead of the default iCloud one. The approval shows which address it goes from.

**Plain drafts no longer show up purple on iPhone.** Mail wrapped script-made drafts in a quote block, which iPhone and iPad render as a purple quote with a bar. Plain drafts are now written the way Mail writes its own (drafts with HTML or attachments still use the old route). One thing remains: iPhone Mail may show a single leading space on the first line.

**Gmail folders resolve.** `mail_accounts` lists Gmail folders as `[Gmail]/Sent Mail`, the paths `mail_search` accepts.

**Contacts opens in place.** An opened person joins its row, with no floating card.
