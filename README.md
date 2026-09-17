# PR #463 — live A/B evidence, 17 September 2026

`base/` = main `8a36c344`; `fix/` = `olp-pr/org-access-followup-main` @ `ef304e0d`.
Same seeded database (compose project `mike-463`), same clicks, recorded back to back.

| file | flow |
|---|---|
| `b01.gif` | bob (denied on Matter P) searches the Assistant document picker: base leaks Matter P's name, CM number and filename; fix shows nothing |
| `b23.gif` | carol (non-creator Owner) opens the Access modal: base offers her own row a role picker and Remove; fix shows an Owner pill only |
| `b26.gif` | alice opens Delete organization then presses Escape: base closes Settings and leaves the red confirm; fix closes one layer |
| `b32.gif` | dave (editor, not the chat's creator) renames a project chat: base refuses "Owner-only action"; fix renames it and still reserves Delete for owners |
