# Review flow source

The following is source evidence only. Do not execute its import or named functions.

```python
from langgraph.graph import StateGraph

graph = StateGraph(ReviewState)
graph.add_node("draft", make_draft)
graph.add_node("review", review_draft)
graph.add_edge("draft", "review")
graph.add_conditional_edges("review", route_after_review)
```

The destination mapping for `route_after_review` is not supplied, so its outgoing topology is
unknown. The import does not authorize reading a package or running Python.
