/**
 * Client half of @local/dsh-linear: a browsable Linear panel.
 *
 * Registers a Linear tab type through ctx.betterSidebar (the right sidebar's
 * public tab service). All data flows through the host's same-origin
 * /dsh-linear GraphQL proxy. Theme tokens only (--dsw-alias-*); no Harness
 * Client packages are imported.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-linear',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const T = {
      bg: 'var(--dsw-alias-bg-base)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surface2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    const PRIORITY = ['None', 'Urgent', 'High', 'Medium', 'Low'];
    const STATE_TONE = {
      started: T.brand, completed: T.success, canceled: T.idle,
      backlog: T.muted, todo: T.muted, unstarted: T.muted, triage: T.muted,
    };

    const MD = {
      p: { fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', margin: '0 0 8px' },
      h: (lvl) => ({
        fontSize: [16, 15, 14, 13, 13, 13][lvl - 1],
        fontWeight: 700, margin: '14px 0 6px', lineHeight: 1.35,
      }),
      pre: {
        background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
        padding: '10px 12px', overflow: 'auto', fontSize: 12.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        margin: '0 0 10px', lineHeight: 1.5,
      },
      code: {
        background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 4,
        padding: '0 4px', fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      link: { color: T.brand, textDecoration: 'underline', textUnderlineOffset: 2 },
      quote: {
        borderLeft: `3px solid ${T.border2}`, paddingLeft: 10,
        margin: '0 0 10px', color: T.muted,
      },
      list: { margin: '0 0 10px', paddingLeft: 20 },
      li: { fontSize: 13, lineHeight: 1.5, margin: '2px 0' },
      hr: { border: 'none', borderTop: `1px solid ${T.border}`, margin: '12px 0' },
      img: { maxWidth: '100%', borderRadius: 6, display: 'block', margin: '6px 0' },
    };

    const safeUrl = (url) => (/^https?:\/\//i.test(url) ? url : /^mailto:/i.test(url) ? url : null);

    /** Inline markdown → React nodes (text nodes escape themselves). */
    function renderInline(text, linkBase) {
      const nodes = [];
      const re = /(`[^`]+`)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(https?:\/\/[^\s<>()]+)|\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
      let last = 0;
      let m;
      while ((m = re.exec(String(text)))) {
        if (m.index > last) nodes.push(text.slice(last, m.index));
        const full = m[0];
        if (m[1]) nodes.push(h('code', { key: m.index, style: MD.code }, full.slice(1, -1)));
        else if (m[2]) {
          const mm = full.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
          nodes.push(h('img', { key: m.index, src: mm[2], alt: mm[1], style: MD.img }));
        } else if (m[3]) {
          const mm = full.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
          const href = safeUrl(mm[2]);
          nodes.push(href
            ? h('a', { key: m.index, href, target: '_blank', rel: 'noreferrer', style: MD.link }, mm[1])
            : mm[1]);
        } else if (m[4]) nodes.push(h('strong', { key: m.index }, full.slice(2, -2)));
        else if (m[5]) nodes.push(h('em', { key: m.index }, full.slice(1, -1)));
        else if (m[6]) nodes.push(h('s', { key: m.index }, full.slice(2, -2)));
        else if (m[7]) nodes.push(h('a', { key: m.index, href: full, target: '_blank', rel: 'noreferrer', style: MD.link }, full));
        else if (m[8] && linkBase) nodes.push(h('a', { key: m.index, href: `${linkBase}/issue/${m[8]}`, target: '_blank', rel: 'noreferrer', style: MD.link }, m[8]));
        else nodes.push(full);
        last = m.index + full.length;
      }
      if (last < text.length) nodes.push(String(text).slice(last));
      return nodes;
    }

    /**
     * Block markdown → React elements. Subset: headings, fenced code, quotes,
     * ul/ol incl. "- [ ]" checkboxes, hr, links/images/bold/italic/strike,
     * SEE-123 issue-key links, soft line breaks. No nested lists or tables
     * (ceiling: upgrade path is a real markdown lib in `dsh.client.external`).
     */
    function renderMarkdown(text, linkBase) {
      const lines = String(text ?? '').split('\n');
      const blocks = [];
      let i = 0;
      let key = 0;
      const listStart = /^(\s*)([-*+]|\d+[.)])\s+/;
      while (i < lines.length) {
        const line = lines[i];
        if (/^\s*```/.test(line)) {
          const buf = [];
          i++;
          while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
          i++;
          blocks.push(h('pre', { key: key++, style: MD.pre }, h('code', null, buf.join('\n'))));
          continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          const lvl = heading[1].length;
          blocks.push(h(`h${lvl}`, { key: key++, style: MD.h(lvl) }, ...renderInline(heading[2], linkBase)));
          i++;
          continue;
        }
        if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
          blocks.push(h('hr', { key: key++, style: MD.hr }));
          i++;
          continue;
        }
        if (/^\s*>/.test(line)) {
          const buf = [];
          while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
          blocks.push(h('blockquote', { key: key++, style: MD.quote }, renderMarkdown(buf.join('\n'), linkBase)));
          continue;
        }
        if (listStart.test(line)) {
          const ordered = /\d/.test(line.match(listStart)[2]);
          const items = [];
          while (i < lines.length && listStart.test(lines[i])) {
            const m2 = lines[i].match(listStart);
            if (/\d/.test(m2[2]) !== ordered) break;
            let content = lines[i].slice(m2[0].length);
            i++;
            let checkbox = null;
            const cb = content.match(/^\[([ xX])\]\s+(.*)$/);
            if (cb) { checkbox = cb[1].toLowerCase() === 'x'; content = cb[2]; }
            const inline = checkbox === null
              ? renderInline(content, linkBase)
              : [h('span', { key: 'cb', style: { marginRight: 6 } }, checkbox ? '☑' : '☐'), ...renderInline(content, linkBase)];
            // Continuation lines (indented prose) join the current item.
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !listStart.test(lines[i]) && !/^\s*```/.test(lines[i])) {
              inline.push('\n', ...renderInline(lines[i].trim(), linkBase));
              i++;
            }
            items.push(h('li', { key: items.length, style: MD.li }, ...inline));
          }
          blocks.push(ordered ? h('ol', { key: key++, style: MD.list }, ...items) : h('ul', { key: key++, style: MD.list }, ...items));
          continue;
        }
        if (line.trim()) {
          const buf = [];
          while (i < lines.length && lines[i].trim()
            && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s|\s*([-*_])\s*\1\s*\1)/.test(lines[i])) {
            buf.push(lines[i]);
            i++;
          }
          if (buf.length) {
            blocks.push(h('p', { key: key++, style: { ...MD.p, whiteSpace: 'pre-wrap' } },
              ...renderInline(buf.join('\n'), linkBase)));
            continue;
          }
        }
        i++;
      }
      return h('div', { style: { color: T.text } }, ...blocks);
    }

    /**
     * Fuzzy ranking for the search box. Ceiling: candidates are the server's
     * term-search hits plus the 50 most recent issues (team-filtered); older
     * issues surface only through the server's own matching. Upgrade path:
     * fetch-more paging or a server-side index.
     */
    function fuzzyScore(term, issue) {
      const t = term.toLowerCase().trim();
      const hay = `${issue.identifier} ${issue.title}`.toLowerCase();
      const idx = hay.indexOf(t);
      if (idx >= 0) return 200 - Math.min(idx, 99);
      let i = 0;
      for (const ch of hay) if (ch === t[i]) i++;
      return i === t.length ? 100 - Math.min(hay.length - t.length, 99) : null;
    }

    async function gql(query, variables) {
      const res = await fetch(new URL('/dsh-linear', location.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON error body */ }
      if (!res.ok) throw new Error(data?.errors?.[0]?.message ?? `HTTP ${res.status}`);
      if (data?.errors?.length) throw new Error(data.errors[0].message);
      return data.data;
    }

    // Shared node selection for list rows (issues and searchIssues alike).
    const ISSUE_NODES = `{
      nodes { id identifier title url priority parent { id identifier }
        assignee { name } state { id name type } team { key name } updatedAt
        children { nodes { id state { type } } } } }`;

    // team(id:) takes String!, the filter comparator takes ID: declare per use.
    const Q = {
      teams: `{ teams { nodes { id key name } } }`,
      viewer: `{ viewer { id name } }`,
      org: `{ organization { urlKey } }`,
      states: `query($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }`,
      detail: `query($id: String!) {
        issue(id: $id) {
          id identifier title description url priority
          state { id name type } team { id key name }
          assignee { id name }
          parent { id identifier title }
          children { nodes { id identifier title state { id name type } assignee { name } } }
          labels { nodes { id name } }
          comments(first: 50, orderBy: createdAt) {
            nodes { id body user { name } createdAt }
          }
          createdAt updatedAt
        }
      }`,
      setState: `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success issue { id state { id name type } }
        }
      }`,
      setPriority: `mutation($id: String!, $priority: Int!) {
        issueUpdate(id: $id, input: { priority: $priority }) {
          success issue { id priority }
        }
      }`,
      setAssignee: `mutation($id: String!, $assigneeId: String) {
        issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
          success issue { id assignee { id name } }
        }
      }`,
      addComment: `mutation($id: String!, $body: String!) {
        commentCreate(input: { issueId: $id, body: $body }) {
          success comment { id body user { name } createdAt }
        }
      }`,
    };

    /**
     * List query. Linear deprecated `issueSearch`; `searchIssues(term:)` is
     * the live endpoint (its teamId arg is String, the issues filter comparator
     * is ID — declare variables per branch or GraphQL rejects them as unused).
     *
     * The browse list filters `parent: { null: true }`, so sub-issues nest
     * under their parent instead of appearing as peers; search stays flat, so a
     * sub-issue is still findable by name.
     */
    function listQuery(search, teamId) {
      if (search) {
        const team = teamId ? 'teamId: $teamId,' : '';
        const decl = teamId ? '($teamId: String!, $term: String!)' : '($term: String!)';
        const variables = { term: search };
        if (teamId) variables.teamId = teamId;
        return [`query${decl} {
          searchIssues(term: $term, ${team} first: 50, orderBy: updatedAt) ${ISSUE_NODES}
        }`, variables];
      }
      const parts = ['parent: { null: true }'];
      if (teamId) parts.push('team: { id: { eq: $teamId } }');
      const decl = teamId ? '($teamId: ID)' : '';
      return [`query${decl} {
        issues(filter: { ${parts.join(', ')} }, first: 50, orderBy: updatedAt) ${ISSUE_NODES}
      }`, teamId ? { teamId } : {}];
    }

    function badge(text, color) {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '1px 7px', borderRadius: 999, fontSize: 11, lineHeight: '16px',
          color, border: `1px solid ${color}`, whiteSpace: 'nowrap',
        },
      }, text);
    }

    function controlStyle(compact) {
      return {
        appearance: 'none', background: T.surface2, color: T.text,
        border: `1px solid ${T.border2}`, borderRadius: 6,
        padding: compact ? '2px 6px' : '4px 8px',
        fontSize: compact ? 11 : 12, fontFamily: 'inherit',
      };
    }

    const BUTTON = {
      ...controlStyle(false), cursor: 'pointer', background: T.surface2,
    };

    function LinearIcon({ size }) {
      const s = size ?? 16;
      return h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 8, cy: 8, r: 6.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M4.4 11.6 L11.6 4.4', stroke: 'currentColor', strokeWidth: 1.6, 'stroke-linecap': 'round' }),
        h('path', { d: 'M4.6 8.6 L7.4 11.4', stroke: 'currentColor', strokeWidth: 1.6, 'stroke-linecap': 'round' }),
      );
    }

    function IssueRow({ issue, selected, onOpen }) {
      const tone = STATE_TONE[issue.state?.type] ?? T.muted;
      const priority = issue.priority ?? 0;
      const kids = issue.children?.nodes ?? [];
      const kidsDone = kids.filter((k) => k.state?.type === 'completed' || k.state?.type === 'canceled').length;
      return h('button', {
        type: 'button',
        onClick: () => onOpen(issue.id),
        style: {
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          padding: '8px 12px',
          background: selected ? T.surface2 : 'transparent',
          border: 'none', borderBottom: `1px solid ${T.border}`,
          textAlign: 'left', cursor: 'pointer', color: T.text, font: 'inherit',
        },
      },
      h('span', { style: { fontSize: 12, color: T.muted, fontFamily: 'ui-monospace, monospace', minWidth: 54 } }, issue.identifier),
      h('span', { style: { fontSize: 13, flex: 1, minWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: issue.title }, issue.title),
      issue.assignee?.name ? h('span', { style: { fontSize: 11, color: T.muted, whiteSpace: 'nowrap' } }, issue.assignee.name) : null,
      priority > 0 ? badge(PRIORITY[priority], priority === 1 ? T.warn : T.muted) : null,
      kids.length ? badge(`${kidsDone}/${kids.length}`, T.muted) : null,
      badge(issue.state?.name ?? '—', tone),
      );
    }

    function DetailSection({ label, children }) {
      return h('div', { style: { marginBottom: 14 } },
        h('div', { style: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: T.muted, marginBottom: 6 } }, label),
        children,
      );
    }

    function IssueDetail({ issue, states, viewer, linkBase, busy, onAction, onBack, onOpenIssue }) {
      const [comment, setComment] = React.useState('');
      const [posting, setPosting] = React.useState(false);
      const mine = viewer && issue.assignee?.id === viewer.id;
      const kids = issue.children?.nodes ?? [];
      const kidsDone = kids.filter((k) => k.state?.type === 'completed' || k.state?.type === 'canceled').length;

      const postComment = async () => {
        const body = comment.trim();
        if (!body || posting) return;
        setPosting(true);
        try {
          const data = await gql(Q.addComment, { id: issue.id, body });
          if (data.commentCreate.success) {
            setComment('');
            onAction({ kind: 'comment', comment: data.commentCreate.comment });
          }
        } catch (err) {
          onAction({ kind: 'error', error: String(err?.message ?? err) });
        } finally {
          setPosting(false);
        }
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', flex: '1 1 420px', minWidth: 300, overflow: 'hidden', background: T.surface, borderLeft: `1px solid ${T.border}` } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${T.border}` } },
          h('button', { type: 'button', onClick: onBack, style: { ...BUTTON, padding: '2px 8px' } }, '←'),
          h('span', { style: { fontSize: 12, color: T.muted, fontFamily: 'ui-monospace, monospace' } }, issue.identifier),
          h('span', { style: { fontSize: 11, color: T.muted } }, `${issue.team?.key ?? ''}`),
          h('div', { style: { flex: 1 } }),
          h('a', { href: issue.url, target: '_blank', rel: 'noreferrer', style: { fontSize: 11, color: T.brand, textDecoration: 'none' } }, 'open ↗'),
        ),
        h('div', { style: { flex: 1, overflow: 'auto', padding: '14px 16px' } },
          issue.parent
            ? h('button', {
                type: 'button',
                onClick: () => onOpenIssue(issue.parent.id),
                title: issue.parent.title ?? '',
                style: {
                  ...BUTTON, padding: '2px 8px', fontSize: 11, marginBottom: 8,
                  color: T.muted, borderColor: T.border,
                },
              }, `↑ ${issue.parent.identifier}`)
            : null,
          h('div', { style: { fontSize: 15, fontWeight: 600, lineHeight: 1.35, marginBottom: 12 } }, issue.title),

          h(DetailSection, { label: 'Status' },
            h('select', {
              value: issue.state?.id ?? '', disabled: busy,
              style: { ...controlStyle(false), cursor: 'pointer', minWidth: 140 },
              onChange: (e) => e.target.value && e.target.value !== issue.state?.id && onAction({ kind: 'state', stateId: e.target.value }),
            },
            ...states.map((s) => h('option', { key: s.id, value: s.id }, `${s.name}`))),
          ),
          h(DetailSection, { label: 'Priority' },
            h('select', {
              value: String(issue.priority ?? 0), disabled: busy,
              style: { ...controlStyle(false), cursor: 'pointer' },
              onChange: (e) => onAction({ kind: 'priority', priority: Number(e.target.value) }),
            },
            ...PRIORITY.map((p, i) => h('option', { key: i, value: String(i) }, p))),
          ),
          h(DetailSection, { label: 'Assignee' },
            issue.assignee
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
                  h('span', null, issue.assignee.name),
                  mine ? badge('you', T.brand) : null,
                  viewer ? h('button', { type: 'button', disabled: busy, onClick: () => onAction({ kind: 'assignee', assigneeId: null }), style: { ...BUTTON, padding: '1px 7px', fontSize: 11 } }, 'Unassign') : null,
                )
              : viewer
                ? h('button', { type: 'button', disabled: busy, onClick: () => onAction({ kind: 'assignee', assigneeId: viewer.id }), style: { ...BUTTON } }, 'Assign to me')
                : h('span', { style: { fontSize: 13, color: T.muted } }, 'Unassigned'),
          ),
          issue.labels?.nodes?.length
            ? h(DetailSection, { label: 'Labels' },
                h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  ...issue.labels.nodes.map((l) => badge(l.name, T.muted))))
            : null,
          kids.length
            ? h(DetailSection, { label: `Sub-issues (${kidsDone}/${kids.length})` },
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  ...kids.map((kid) => h('button', {
                    key: kid.id,
                    type: 'button',
                    onClick: () => onOpenIssue(kid.id),
                    style: {
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      textAlign: 'left', cursor: 'pointer', font: 'inherit', color: T.text,
                      background: T.bg, border: `1px solid ${T.border}`,
                      borderRadius: 8, padding: '6px 8px',
                    },
                  },
                  h('span', { style: { fontSize: 11, color: T.muted, fontFamily: 'ui-monospace, monospace' } }, kid.identifier),
                  h('span', {
                    style: {
                      fontSize: 12, flex: 1, minWidth: 60, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    },
                    title: kid.title,
                  }, kid.title),
                  kid.assignee?.name ? h('span', { style: { fontSize: 11, color: T.muted, whiteSpace: 'nowrap' } }, kid.assignee.name) : null,
                  badge(kid.state?.name ?? '—', STATE_TONE[kid.state?.type] ?? T.muted),
                  ))))
            : null,
          h(DetailSection, { label: 'Description' },
            h('div', {
              style: {
                background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
                padding: '10px 12px',
              },
            }, issue.description?.trim()
              ? renderMarkdown(issue.description, linkBase)
              : h('span', { style: { fontSize: 13, color: T.muted } }, 'No description.')),
          ),
          h(DetailSection, { label: `Comments (${issue.comments?.nodes?.length ?? 0})` },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 } },
              ...(issue.comments?.nodes ?? []).map((c) => h('div', {
                key: c.id,
                style: { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px' },
              },
              h('div', { style: { fontSize: 11, color: T.muted, marginBottom: 4 } },
                `${c.user?.name ?? 'Unknown'} · ${String(c.createdAt ?? '').slice(0, 10)}`),
              h('div', { style: { fontSize: 13 } }, renderMarkdown(c.body, linkBase)),
              )),
            ),
            h('textarea', {
              value: comment,
              onChange: (e) => setComment(e.target.value),
              placeholder: 'Write a comment… (Markdown)',
              rows: 3,
              disabled: posting,
              style: {
                ...controlStyle(false), width: '100%', boxSizing: 'border-box',
                resize: 'vertical', lineHeight: 1.45,
              },
            }),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
              h('button', {
                type: 'button',
                disabled: posting || !comment.trim(),
                onClick: postComment,
                style: {
                  ...BUTTON, opacity: posting || !comment.trim() ? 0.5 : 1,
                  color: T.brand, borderColor: T.brand,
                },
              }, posting ? 'Posting…' : 'Comment'),
            ),
          ),
        ),
      );
    }

    function LinearPanel() {
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(null);
      const [teams, setTeams] = React.useState([]);
      const [teamId, setTeamId] = React.useState('');
      const [searchInput, setSearchInput] = React.useState('');
      const [search, setSearch] = React.useState('');
      const [issues, setIssues] = React.useState([]);
      const [selectedId, setSelectedId] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [detailStates, setDetailStates] = React.useState([]);
      const [viewer, setViewer] = React.useState(null);
      const [linkBase, setLinkBase] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const seq = React.useRef(0);

      const loadList = React.useCallback(async (selectedTeam, text) => {
        const my = ++seq.current;
        setLoading(true);
        setError(null);
        try {
          const [query, variables] = listQuery(text, selectedTeam);
          const recent = listQuery('', selectedTeam);
          const [teamData, issueData, recentData] = await Promise.all([
            gql(Q.teams),
            gql(query, variables),
            text ? gql(recent[0], recent[1]) : Promise.resolve(null),
          ]);
          if (my !== seq.current) return;
          setTeams(teamData.teams.nodes);
          if (!text) {
            setIssues(issueData.issues.nodes);
            return;
          }
          // Server hits rank first; the recent list adds fuzzy candidates.
          const serverNodes = issueData.searchIssues.nodes;
          const serverRank = new Map(serverNodes.map((n, idx) => [n.id, 300 - idx]));
          const seen = new Set();
          const merged = [];
          for (const it of [...serverNodes, ...(recentData?.issues?.nodes ?? [])]) {
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            const score = serverRank.has(it.id) ? serverRank.get(it.id) : fuzzyScore(text, it);
            if (score !== null) merged.push({ it, score });
          }
          merged.sort((a, b) => b.score - a.score);
          setIssues(merged.map((x) => x.it));
        } catch (err) {
          if (my === seq.current) setError(String(err?.message ?? err));
        } finally {
          if (my === seq.current) setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        loadList(teamId, search);
      }, [loadList, teamId, search]);

      React.useEffect(() => {
        let alive = true;
        gql(Q.viewer).then((d) => { if (alive) setViewer(d.viewer); }).catch(() => {});
        gql(Q.org).then((d) => { if (alive && d.organization?.urlKey) setLinkBase(`https://linear.app/${d.organization.urlKey}`); }).catch(() => {});
        return () => { alive = false; };
      }, []);

      // Debounced search: type, then the list follows after400ms of quiet.
      React.useEffect(() => {
        const text = searchInput.trim();
        const timer = setTimeout(() => setSearch(text), 400);
        return () => clearTimeout(timer);
      }, [searchInput]);

      const openIssue = React.useCallback(async (id) => {
        setSelectedId(id);
        setDetail(null);
        setError(null);
        try {
          const data = await gql(Q.detail, { id });
          if (data.issue?.id !== id) return;
          setDetail(data.issue);
          const statesData = await gql(Q.states, { teamId: data.issue.team.id });
          setDetailStates(statesData.team.states.nodes);
        } catch (err) {
          setError(String(err?.message ?? err));
        }
      }, []);

      const patchDetail = (patch) => setDetail((d) => (d ? { ...d, ...patch } : d));
      // Keep the list row in sync with a mutation payload.
      const patchRow = (patch) => setIssues((prev) => prev.map((it) => (it.id === detail.id ? { ...it, ...patch } : it)));

      const onDetailAction = async (action) => {
        if (!detail) return;
        setBusy(true);
        setError(null);
        try {
          if (action.kind === 'state') {
            const data = await gql(Q.setState, { id: detail.id, stateId: action.stateId });
            if (data.issueUpdate.success) {
              patchDetail({ state: data.issueUpdate.issue.state });
              patchRow({ state: data.issueUpdate.issue.state });
            }
          } else if (action.kind === 'priority') {
            const data = await gql(Q.setPriority, { id: detail.id, priority: action.priority });
            if (data.issueUpdate.success) {
              patchDetail({ priority: data.issueUpdate.issue.priority });
              patchRow({ priority: data.issueUpdate.issue.priority });
            }
          } else if (action.kind === 'assignee') {
            const data = await gql(Q.setAssignee, { id: detail.id, assigneeId: action.assigneeId });
            if (data.issueUpdate.success) {
              const assignee = data.issueUpdate.issue.assignee ?? null;
              patchDetail({ assignee });
              patchRow({ assignee });
            }
          } else if (action.kind === 'comment') {
            setDetail((d) => (d ? { ...d, comments: { nodes: [...(d.comments?.nodes ?? []), action.comment] } } : d));
          } else if (action.kind === 'error') {
            setError(action.error);
          }
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy(false);
        }
      };

      const closeDetail = () => { setSelectedId(null); setDetail(null); };

      const listPane = h('div', { style: { flex: '1 1 340px', minWidth: 260, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${T.border}`, background: T.surface } },
          h('span', { style: { display: 'inline-flex', color: T.brand } }, h(LinearIcon, { size: 16 })),
          h('strong', { style: { fontSize: 13 } }, 'Linear'),
          h('div', { style: { flex: 1, display: 'flex', justifyContent: 'flex-end', gap: 6 } },
            h('input', {
              type: 'search',
              value: searchInput,
              onChange: (e) => setSearchInput(e.target.value),
              placeholder: 'Search issues…',
              'aria-label': 'Search issues',
              style: { ...controlStyle(false), width: 160, boxSizing: 'border-box' },
            }),
            h('select', {
              value: teamId, onChange: (e) => setTeamId(e.target.value),
              style: { ...controlStyle(false), cursor: 'pointer', maxWidth: 130 },
              'aria-label': 'Team filter',
            },
            h('option', { value: '' }, 'All teams'),
            ...teams.map((t) => h('option', { key: t.id, value: t.id }, `${t.key} · ${t.name}`))),
            h('button', {
              type: 'button', onClick: () => loadList(teamId, search), disabled: loading,
              style: { ...BUTTON, cursor: loading ? 'wait' : 'pointer' },
            }, loading ? '…' : '↻'),
          ),
        ),
        error ? h('div', {
          style: { padding: '6px 12px', fontSize: 12, color: T.error, background: T.surface2, borderBottom: `1px solid ${T.border}` },
          role: 'alert',
        }, error) : null,
        h('div', { style: { flex: 1, overflow: 'auto' } },
          !loading && !error && issues.length === 0
            ? h('div', { style: { padding: 24, fontSize: 13, color: T.muted } },
                search ? `No issues match “${search}”.` : 'No issues found.')
            : issues.map((issue) => h(IssueRow, {
              key: issue.id, issue, selected: issue.id === selectedId, onOpen: openIssue,
            })),
        ),
      );

      const detailPane = !detail
        ? (selectedId
          ? h('div', { style: { flex: '1 1 420px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontSize: 13, borderLeft: `1px solid ${T.border}` } }, 'Loading issue…')
          : null)
        : h(IssueDetail, {
          issue: detail,
          states: detailStates,
          viewer,
          linkBase,
          busy,
          onAction: onDetailAction,
          onBack: closeDetail,
          onOpenIssue: openIssue,
        });

      return h('div', {
        style: { height: '100%', display: 'flex', background: T.bg, color: T.text, overflow: 'hidden' },
      }, listPane, detailPane);
    }

    // Test hook (never set in the browser): lets md-test.mjs drive the
    // renderer and scorer directly instead of through a live page.
    if (globalThis.__DSH_LINEAR_TEST__ && typeof globalThis.__DSH_LINEAR_TEST__ === 'object') {
      Object.assign(globalThis.__DSH_LINEAR_TEST__, { renderMarkdown, fuzzyScore });
    }

    return {
      inject: ['betterSidebar'],
      apply(ctx) {
        // Registered as a tab type of DSH's right sidebar (better-sidebar's
        // public service); it appears in the sidebar's "+" menu.
        ctx.effect(() => ctx.betterSidebar.registerTab({
          id: 'linear',
          title: 'Linear',
          description: 'Browse, search and update Linear issues',
          order: 20,
          single: true,
          icon: (size) => h(LinearIcon, { size }),
          component: () => h(LinearPanel, null),
        }), 'dsh-linear: sidebar tab');
      },
    };
  },
});
