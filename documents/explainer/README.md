# NH-1 Paper · Conversation Package

David,

This is the full back-and-forth that produced the four artifacts here. The user asked Claude to explain your paper in plain language, then iterated on tone and elegance, then asked for it typeset Tufte-style with custom illustrations, and finally to convert to LaTeX. You can read the conversation in `CONVERSATION.md` and the deliverables in `artifacts/`.

## What's here

- **`CONVERSATION.md`** — the seven prompts and a short note about what each response produced.
- **`artifacts/nh1-explained.md`** — the prose explainer for a bright high-school reader.
- **`artifacts/nh1-tufte.html`** — the Tufte-book HTML edition (cream background, margin notes, four hand-coded SVG figures). Open in any browser.
- **`artifacts/nh1-tufte.tex`** — the same document as LaTeX (`tufte-handout` class, all figures as TikZ / pgfplots).
- **`artifacts/nh1-tufte.pdf`** — the rendered LaTeX, 11 pages.

## Reading order suggestion

If you just want the prose: `nh1-explained.md`.
If you want to see how it looks typeset: open `nh1-tufte.pdf`.
If you want to see how the conversation unfolded: `CONVERSATION.md`.

## Compiling the LaTeX yourself

```
pdflatex nh1-tufte.tex
pdflatex nh1-tufte.tex   # second pass for cross-references
```

Requires `tufte-latex`, `tikz`, `pgfplots`, `booktabs`, `microtype` (all standard in TeX Live).

The four figures are vector — TikZ / pgfplots in the `.tex`, inline SVG in the `.html` — so they scale cleanly and have no external dependencies.
