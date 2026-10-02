# The guard, explained

This server lets an AI assistant change records in Salesforce (Contacts, Accounts and Opportunities) without ever being able to overwrite someone else's work by accident. It does this with three ideas.

## 1. The coat check ticket (the proposal id)

When you hand over your coat, you get a numbered ticket. The ticket isn't the coat and doesn't describe it. It just lets you claim the coat later, once.

Here, the AI never makes a change in one go. First it calls `propose_update`. The server looks up the record as it is right now, works out exactly what would change ("Amount: 50,000 → 75,000"), writes that down, and hands back a ticket: the **proposal id**. Nothing in Salesforce has changed yet.

To make the change, the AI hands the ticket back to `confirm_update`, and the ticket is the only thing it can hand back. Like a real coat check:

- **The ticket works once.** It's torn up when used, so the same change can't be replayed.
- **The ticket expires.** After 15 minutes it's no good, because the world may have moved on.
- **The ticket only fits one coat.** A ticket for an Account change can't be used to change a Contact.

## 2. Chain of custody (why the server keeps the "before", not the AI)

In a court case, evidence only counts if you can show nobody had a chance to tamper with it between collection and trial. Whoever might benefit from changing it never holds it.

The "before" values are the evidence here. They're what the record looked like when the change was proposed, and they're what the server checks against later. If the AI held them and sent them back at confirm time, a confused or manipulated AI could send back whatever made the check pass, and the check would be theatre.

So the server keeps the "before" snapshot itself, along with which object and which record it's for. The AI only ever holds the ticket. There's nothing for it to alter.

## 3. The builder who re-checks the site (re-verifying at confirm)

A good builder gets plans approved, then walks the site again on the morning work starts. If someone has moved the fence or dug a trench since the survey, the builder stops and gets the plans redone. They don't build on assumptions from last week.

`confirm_update` does the same. Before writing anything it fetches the record from Salesforce **again**, and compares every field it's about to change against the "before" snapshot. If even one has changed, because a colleague edited it in the meantime, the whole change is refused as **stale** and nothing is written. The colleague's edit survives, and the AI has to propose again from the new state.

## A worked example

A sales rep's Opportunity shows Amount 50,000.

1. The AI proposes raising it to 75,000. The server records "before: 50,000, after: 75,000" and gives back a ticket.
2. Meanwhile the rep's manager opens the same Opportunity in Salesforce and changes the Amount to 60,000.
3. The AI hands in the ticket. The server re-reads the record, sees 60,000 where it expected 50,000, and refuses: *stale*.
4. The manager's 60,000 stands. The audit log records both the proposal and the refusal, so anyone can see exactly what was attempted and why it was stopped.

That's why Amount and StageName are allowed at all. They're the fields where silently overwriting someone matters most, so they're the ones that most need this protection.

## The rest, in one line each

- **Allowlist:** each object has a short list of fields that can be changed. Everything else is refused up front.
- **Audit log:** every proposal, write and refusal is appended to a log that is never edited, and each entry is tagged with the object it was about.
- **Proof:** the tests deliberately break the stale check and confirm that the stale tests fail. A test that can't fail proves nothing.
