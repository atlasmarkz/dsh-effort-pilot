# Market submission

This file is the entry submitted to the community plugin index
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
which powers the DSH plugin market (`Plugins → Discover` and the
[dsh-market](https://github.com/dsh-market/dsh-market) storefront).

The upstream process accepts **one YAML file per plugin** at
`data/plugins/<owner>__<repo>.yml`. The exact content to submit is
[`awesome-dsh-plugin.yml`](./awesome-dsh-plugin.yml) in this directory:

```text
data/plugins/atlasmarkz__dsh-effort-pilot.yml
```

Listing requirements (checked by CI, then read by a maintainer):

- the repository declares a `dsh.bundle` manifest in `package.json` — done;
- the repository is public and at least **1 day old** when the PR is opened;
- real working code (no placeholder repos) — 40 tests + a loadable plugin;
- the `dsh-plugin` topic is set on the repository;
- the description states what the plugin does, without marketing claims;
- the icon is a GitHub-hosted **raster** image (SVG is rejected by the list).

Everything above is prepared in this repository, so the PR only needs the one
YAML file. After the PR merges, the site rebuilds automatically; the npm
package (once published) is linked by its `repository` field without an extra
entry field.
