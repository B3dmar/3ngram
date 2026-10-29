---
"@3ngram/server": patch
---

The `review_proposals` tool description names all four proposal kinds (consolidation edges, extracted facts, resolution proposals, retention proposals from the forgetting pass) instead of two. The tool-selection embeddings are regenerated for the changed text, one consolidation scenario becomes a retention one so the five scenarios cover the kinds the tool reviews, and the eval gate passes at the current floors.
