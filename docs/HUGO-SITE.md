# docs/ -- GitHub Pages site (Hugo)

This `docs/` folder does double duty: `README.md` here is the Kronos `.PCG`/`.SNG`
file-format reference (unrelated to Hugo -- don't confuse the two), while everything else
(`config/`, `content/`, `layouts/`, `assets/`, `static/`) is the Hugo site source for the
project's GitHub Pages site, deployed by `../.github/workflows/hugo.yml` on every push to
`main`. Built with [Hugo](https://gohugo.io/) and the
[Stack theme](https://github.com/CaiJimmy/hugo-theme-stack), copied from the sibling
`DIY-MIDI-METRONOME.public/documentation-github-page` site (same author, same template).

## Local development

Hugo (extended) and Go are required to build this site; both are pinned into the bundled
Docker image, so no local install is needed:

```bash
cd docs
docker compose up
```

Then open http://localhost:1313. Content lives under `content/`; the theme config is
under `config/_default/`.

## Structure

- `content/overview` -- project intro
- `content/me` -- author bio + legal notice (Impressum/Datenschutzerklärung), reused
  verbatim (same author) from the sibling DIY project sites

## One-time repo setup

GitHub Pages needs to be switched to "GitHub Actions" as its source under this repo's
Settings > Pages -- this hasn't been done yet and isn't something this tool can flip on
its own.
