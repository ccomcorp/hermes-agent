/* /agent/status/{job_id} contract (Python plugin_api.py, agent_status()): { ok, job_id,
   running, exit_code, summary, started_at, finished_at, logs, auth_error, phase,
   applied, last_change_at, target_file, resolution_source }.
   A renamed field here is a silent undefined -- keep in sync with plugin_api.py. */

/* AIOS auth shim (F1): canvas uses raw fetch and omits the session token the
   fork gates /api/plugins/* on in loopback mode -> 401. Wrap window.fetch to
   inject X-Hermes-Session-Token for canvas's own API base only. */
(function () {
  "use strict";
  var HEADER = "X-Hermes-Session-Token";
  var PREFIX = "/api/plugins/hermes-canvas";
  if (window.__HERMES_CANVAS_FETCH_SHIMMED__) return;
  window.__HERMES_CANVAS_FETCH_SHIMMED__ = true;
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var u = new URL(url, location.origin);
      if (u.origin === location.origin && u.pathname.indexOf(PREFIX) === 0) {
        init = init || {};
        var headers = new Headers(init.headers || {});
        var token = window.__HERMES_SESSION_TOKEN__;
        if (token && !headers.has(HEADER)) headers.set(HEADER, token);
        init.headers = headers;
        if (init.credentials == null) init.credentials = "include";
      }
    } catch (e) { /* fall through */ }
    return origFetch(input, init);
  };
})();
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // SDK Setup
  // -------------------------------------------------------------------------
  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !SDK.React) {
    console.error('Hermes Canvas: missing plugin SDK');
    return;
  }

  const React = SDK.React;
  const h = React.createElement;
  const { useState, useEffect, useCallback, useRef } = React;
  const UI = SDK.components || SDK.ui || {};
  const API_BASE = '/api/plugins/hermes-canvas';

  // -------------------------------------------------------------------------
  // Fallback UI Components
  // -------------------------------------------------------------------------
  function join() {
    return Array.prototype.slice.call(arguments).filter(Boolean).join(' ');
  }

  function fb(tag, base) {
    return function Fallback(props) {
      const { children, className } = props || {};
      const next = Object.assign({}, props);
      delete next.children;
      delete next.className;
      return h(tag, Object.assign(next, { className: join(base, className) }), children);
    };
  }

  const Card = UI.Card || fb('section', 'rounded-lg border bg-card text-card-foreground');
  const CardHeader = UI.CardHeader || fb('div', 'p-4 pb-2');
  const CardTitle = UI.CardTitle || fb('h3', 'font-semibold leading-none');
  const CardContent = UI.CardContent || fb('div', 'p-4 pt-2');
  const Button = UI.Button || fb('button', 'rounded border px-3 py-2 text-sm');
  const Badge = UI.Badge || fb('span', 'inline-flex rounded border px-2 py-1 text-xs');
  const Separator = UI.Separator || fb('div', 'h-px w-full bg-border');

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------
  function apiJSON(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 15000);
    return fetch(url, Object.assign({ signal: controller.signal }, options || {}))
      .then(function (response) {
        return response.text().then(function (body) {
          clearTimeout(timer);
          let parsed = null;
          try { parsed = body ? JSON.parse(body) : null; } catch (err) { parsed = body; }
          if (!response.ok) {
            const detail = parsed && parsed.detail ? parsed.detail : (body || response.statusText);
            throw new Error(detail);
          }
          return parsed;
        });
      });
  }

  function postJSON(path, payload) {
    return apiJSON(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  function getJSON(path) {
    return apiJSON(API_BASE + path, { method: 'GET' });
  }

  function text(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback || '';
    return String(value);
  }

  function trimText(str, limit) {
    const s = String(str || '').replace(/\s+/g, ' ').trim();
    return s.length > limit ? s.slice(0, limit - 1) + '\u2026' : s;
  }

  function getOrigin(url) {
    try { return new URL(url).origin; } catch (err) { return '*'; }
  }

  // Phase labels for the agent-status stepper (mirrors _compute_phase in plugin_api.py).
  var PHASE_LABEL = {
    queued: 'Queued',
    editing: 'Editing',
    applied: 'Edit applied',
    done_ok: 'Done',
    done_failed: 'Failed',
    needs_shell: 'Needs shell (not run)'
  };
  var PHASE_STEP_ORDER = ['queued', 'editing', 'applied', 'done_ok'];

  // Warn once (not per-poll) if the /agent/status/{job_id} payload drops a field
  // this UI depends on -- catches a silent rename in plugin_api.py.
  var _warnedMissingStatusFields = false;
  function checkStatusFieldContract(data) {
    if (_warnedMissingStatusFields || !data) return;
    var missing = ['phase', 'applied', 'auth_error'].filter(function (k) { return !(k in data); });
    if (missing.length) {
      missing.forEach(function (k) { console.warn('[canvas] status missing field:', k); });
      _warnedMissingStatusFields = true;
    }
  }

  // Reload the preview iframe exactly once per completed edit, debounced against
  // the static-server's own 1s reload poller (see hermes_static_server.py).
  var _lastReloadAt = 0;
  function reloadPreviewOnce() {
    var now = Date.now();
    if (now - _lastReloadAt < 1500) return;
    _lastReloadAt = now;
    var f = document.querySelector('.hc-preview-frame');
    if (f && f.contentWindow) f.contentWindow.location.reload();
  }

  function installCanvasThemeReset() {
    const id = 'hermes-canvas-theme-reset';
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    style.textContent = `
      html:has(.hc-root),
      body:has(.hc-root),
      body:has(.hc-root) #root,
      body:has(.hc-root) main,
      body:has(.hc-root) [role="main"] {
        background: var(--ui-chat-surface-background) !important;
        background-color: var(--ui-chat-surface-background) !important;
        background-image: none !important;
        background-blend-mode: normal !important;
      }
      body:has(.hc-root)::before,
      body:has(.hc-root)::after,
      body:has(.hc-root) #root::before,
      body:has(.hc-root) #root::after,
      body:has(.hc-root) main::before,
      body:has(.hc-root) main::after,
      body:has(.hc-root) [role="main"]::before,
      body:has(.hc-root) [role="main"]::after {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        content: none !important;
        background: transparent !important;
        background-image: none !important;
      }
      body:has(.hc-root) [class~="pointer-events-none"][class~="fixed"][class~="inset-0"],
      body:has(.hc-root) .hcc-overlay,
      body:has(.hc-root) .theme-default-filler {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        background: transparent !important;
        background-image: none !important;
        mix-blend-mode: normal !important;
        filter: none !important;
      }
    `;
  }

  // -------------------------------------------------------------------------
  // ProjectPanel
  // -------------------------------------------------------------------------
  function ProjectPanel(props) {
    const [parentDir, setParentDir] = useState('');
    const [projectName, setProjectName] = useState('');
    const [openPath, setOpenPath] = useState('');
    const [creating, setCreating] = useState(false);
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState('');

    const onCreate = useCallback(function () {
      const parent = (parentDir || '').trim();
      const name = (projectName || '').trim();
      if (!name) { setError('Enter a project name'); return; }
      setError('');
      setCreating(true);
      postJSON('/project/create', { parentDir: parent || null, name: name, template: 'vite-react' })
        .then(function (res) {
          if (props.onProjectChange) props.onProjectChange(res.project_path);
          setProjectName('');
        })
        .catch(function (err) { setError(text(err.message, 'Create failed')); })
        .finally(function () { setCreating(false); });
    }, [parentDir, projectName, props.onProjectChange]);

    const onOpen = useCallback(function () {
          const path = (openPath || '').trim();
          // AIOS UX: the top path is a READ-ONLY status chip (current project), NOT the
          // open field. Empty openPath used to show a bare "Enter a project path" error
          // that sat above the chip and looked like a label for a locked input.
          if (!path) {
            setError('Paste a folder path in the box under Open existing project, then click Open. Example: I:\\PROJECTS\\AIFIN\\frontend');
            return;
          }
          setError('');
          setOpening(true);
          postJSON('/project/open', { projectPath: path })
            .then(function (res) {
              if (props.onProjectChange) props.onProjectChange(res.project_path);
              setOpenPath('');
            })
            .catch(function (err) { setError(text(err.message, 'Open failed')); })
            .finally(function () { setOpening(false); });
        }, [openPath, props.onProjectChange]);

        return h('div', { className: 'hc-panel' },
          h('div', { className: 'hc-panel-title' }, 'Project'),
          error ? h('p', { className: 'text-xs text-red-500 hc-error' }, error) : null,

          // AIOS: explicit "Current project" label + non-input styling so this is never
          // mistaken for an editable path field (the real open box is further below).
          h('label', { className: 'text-xs text-muted-foreground' }, 'Current project'),
          props.projectPath
            ? h('div', {
                className: 'hc-current-path',
                title: props.projectPath
              }, props.projectPath)
            : h('p', { className: 'text-xs text-muted-foreground' }, 'None selected yet'),

          h(Separator, null),

          // Open-existing first: primary path for real apps (AIFIN, etc.)
          h('div', { className: 'flex flex-col gap-2' },
            h('label', { className: 'text-xs text-muted-foreground' }, 'Open existing project'),
            h('p', { className: 'text-xs text-muted-foreground' },
              'Type or paste a full folder path that contains package.json or index.html, then click Open.'
            ),
            h('div', { className: 'hc-form-row' },
              h('input', {
                className: 'hc-input',
                placeholder: 'I:\\PROJECTS\\AIFIN\\frontend',
                value: openPath,
                onChange: function (e) { setOpenPath(e.target.value); },
                onKeyDown: function (e) {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onOpen();
                  }
                }
              }),
              h(Button, {
                className: 'hc-btn hc-btn-primary',
                onClick: onOpen,
                disabled: opening
              }, opening ? 'Opening...' : 'Open')
            )
          ),

          h(Separator, null),

          h('div', { className: 'flex flex-col gap-2' },
            h('label', { className: 'text-xs text-muted-foreground' }, 'Create new project'),
            h('div', { className: 'hc-form-row' },
              h('input', {
                className: 'hc-input',
                placeholder: 'Project name',
                value: projectName,
                onChange: function (e) { setProjectName(e.target.value); }
              }),
              h(Button, {
                className: 'hc-btn hc-btn-primary',
                onClick: onCreate,
                disabled: creating
              }, creating ? 'Creating...' : 'Create')
            ),
            h('input', {
              className: 'hc-input',
              placeholder: props.defaultProjectParent ? 'Default: ' + props.defaultProjectParent : 'Default: ~/.hermes/canvas-projects',
              value: parentDir,
              onChange: function (e) { setParentDir(e.target.value); }
            }),
            h('p', { className: 'text-xs text-muted-foreground' },
              'Leave blank to create under ',
              h('code', null, props.defaultProjectParent || '~/.hermes/canvas-projects')
            )
          )
        );
  }

  // -------------------------------------------------------------------------
  // DevServerPanel
  // -------------------------------------------------------------------------
  function DevServerPanel(props) {
    const [starting, setStarting] = useState(false);
    const [stopping, setStopping] = useState(false);

    const onStart = useCallback(function () {
      if (!props.projectPath) return;
      setStarting(true);
      postJSON('/dev/start', { projectPath: props.projectPath })
        .then(function (res) {
          if (props.onStatusChange) props.onStatusChange();
        })
        .catch(function (err) {
          alert('Failed to start dev server: ' + text(err.message, 'Unknown error'));
        })
        .finally(function () { setStarting(false); });
    }, [props.projectPath, props.onStatusChange]);

    const onStop = useCallback(function () {
      setStopping(true);
      postJSON('/dev/stop', {})
        .then(function () {
          if (props.onStatusChange) props.onStatusChange();
        })
        .finally(function () { setStopping(false); });
    }, [props.onStatusChange]);

    return h('div', { className: 'hc-panel' },
      h('div', { className: 'hc-panel-title' }, 'Dev Server'),
      h('div', { className: 'flex flex-wrap items-center gap-2' },
        props.devServerRunning
          ? h('span', { className: 'hc-badge hc-badge-success' }, 'Running')
          : h('span', { className: 'hc-badge hc-badge-warn' }, 'Stopped'),
        props.previewUrl
          ? h('a', {
              className: 'text-xs underline text-muted-foreground',
              href: props.previewUrl,
              target: '_blank',
              rel: 'noreferrer'
            }, trimText(props.previewUrl, 40))
          : null
      ),
      h('div', { className: 'hc-form-row' },
        h(Button, {
          className: 'hc-btn hc-btn-primary',
          onClick: onStart,
          disabled: starting || !props.projectPath || props.devServerRunning
        }, starting ? h('span', null, h('span', { className: 'hc-spinner' }), ' Starting') : 'Start'),
        h(Button, {
          className: 'hc-btn hc-btn-danger',
          onClick: onStop,
          disabled: stopping || !props.devServerRunning
        }, stopping ? 'Stopping...' : 'Stop'),
        h(Button, {
          className: 'hc-btn',
          onClick: function () {
            if (props.previewUrl && props.iframeRef && props.iframeRef.current) {
              props.iframeRef.current.src = props.previewUrl;
            }
          },
          disabled: !props.previewUrl
        }, 'Refresh')
      )
    );
  }

  // -------------------------------------------------------------------------
  // PromptPanel
  // -------------------------------------------------------------------------
  function PromptPanel(props) {
    const [prompt, setPrompt] = useState('');
    const [sending, setSending] = useState(false);

    const onSend = useCallback(function () {
      const p = (prompt || '').trim();
      if (!p) return;
      if (!props.projectPath) { alert('Select a project first'); return; }
      setSending(true);
      postJSON('/agent/prompt', {
        projectPath: props.projectPath,
        prompt: p,
        selectedElement: props.selectedElement || null
      })
        .then(function (res) {
          setPrompt('');
          if (props.onJobStarted) props.onJobStarted(res.job_id);
        })
        .catch(function (err) {
          alert('Failed to send prompt: ' + text(err.message, 'Unknown error'));
        })
        .finally(function () { setSending(false); });
    }, [prompt, props.projectPath, props.selectedElement, props.onJobStarted]);

    return h('div', { className: 'hc-panel' },
      h('div', { className: 'hc-panel-title' }, 'Prompt Hermes'),
      h('textarea', {
        className: 'hc-textarea',
        placeholder: 'e.g. "Build a dark landing page with a hero section and pricing cards..."',
        value: prompt,
        onChange: function (e) { setPrompt(e.target.value); },
        onKeyDown: function (e) {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
        }
      }),
      h('div', { className: 'flex items-center justify-between' },
        h('span', { className: 'text-[10px] text-muted-foreground' }, 'Cmd/Ctrl + Enter to send'),
        h(Button, {
          className: 'hc-btn hc-btn-primary',
          onClick: onSend,
          disabled: sending || !props.projectPath
        }, sending ? h('span', null, h('span', { className: 'hc-spinner' }), ' Sending') : 'Send to Hermes')
      )
    );
  }

  // -------------------------------------------------------------------------
  // SelectionPanel
  // -------------------------------------------------------------------------
  function SelectionPanel(props) {
    const el = props.selectedElement;
    if (!el) return null;

    return h('div', { className: 'hc-panel' },
      h('div', { className: 'hc-panel-title' }, 'Selected Element'),
      h('div', { className: 'hc-selected-el' },
        h('div', { className: 'flex items-center justify-between mb-2' },
          h('span', { className: 'font-semibold' }, text(el.tag, 'unknown')),
          h(Button, {
            className: 'hc-btn',
            onClick: props.onClear
          }, 'Clear')
        ),
        h('pre', null, JSON.stringify(el, null, 2))
      )
    );
  }

  // -------------------------------------------------------------------------
  // PhaseStepperPanel -- live phase of the currently-running/most-recent agent job
  // -------------------------------------------------------------------------
  function PhaseStepperPanel(props) {
    const phase = props.phase;
    if (!phase) return null;

    const failed = phase === 'done_failed';
    const stepEls = PHASE_STEP_ORDER.map(function (s) {
      const reached = PHASE_STEP_ORDER.indexOf(s) <= PHASE_STEP_ORDER.indexOf(phase);
      return h('span', {
        key: s,
        className: join('step', !failed && reached && 'active')
      }, PHASE_LABEL[s]);
    });
    if (phase === 'needs_shell') {
      stepEls.push(h('span', { key: 'needs_shell', className: 'step active' }, PHASE_LABEL.needs_shell));
    }
    if (failed) {
      stepEls.push(h('span', { key: 'done_failed', className: 'step failed' }, PHASE_LABEL.done_failed));
    }

    return h('div', { className: 'hc-panel' },
      h('div', { className: 'hc-panel-title' }, 'Agent Status'),
      h('div', { className: 'hermes-phase' }, stepEls),
      props.authError ? h('p', { className: 'text-xs text-red-500' }, 'Authentication failed - refresh token') : null,
      props.targetFile ? h('p', { className: 'text-xs text-muted-foreground' }, 'Editing: ' + props.targetFile) : null
    );
  }

  // -------------------------------------------------------------------------
  // AgentJobsPanel
  // -------------------------------------------------------------------------
  function AgentJobsPanel(props) {
    const jobs = props.jobs || {};
    const entries = Object.entries(jobs).sort(function (a, b) {
      const aTime = (a[1] && (a[1].started_at || a[1].finished_at)) || a[0];
      const bTime = (b[1] && (b[1].started_at || b[1].finished_at)) || b[0];
      return String(bTime).localeCompare(String(aTime));
    });

    return h('div', { className: 'hc-panel' },
      h('div', { className: 'flex items-center justify-between gap-2' },
        h('div', { className: 'hc-panel-title' }, 'Agent Activity'),
        h(Button, {
          className: 'hc-btn hc-btn-compact',
          onClick: props.onClear,
          disabled: entries.length === 0 || props.clearing
        }, props.clearing ? 'Clearing...' : 'Clear Activity')
      ),
      entries.length === 0
        ? h('p', { className: 'text-xs text-muted-foreground' }, 'No agent jobs yet.')
        : h('div', { className: 'hc-job-list' },
            entries.map(function ([jobId, job]) {
              const isRunning = job.running;
              return h('div', { key: jobId, className: 'hc-job-item' },
                h('div', { className: 'flex items-center justify-between' },
                  h('span', { className: 'font-medium' }, trimText(jobId, 30)),
                  isRunning
                    ? h('span', { className: 'hc-badge hc-badge-success' }, 'Running')
                    : h('span', { className: 'hc-badge' }, 'Done')
                ),
                h('p', { className: 'text-muted-foreground' }, trimText(job.prompt || '', 80)),
                job.summary ? h('p', { className: 'text-xs text-muted-foreground' }, trimText(job.summary, 100)) : null,
                job.exit_code !== null && job.exit_code !== undefined
                  ? h('p', { className: job.exit_code === 0 ? 'text-xs text-green-500' : 'text-xs text-red-500' },
                      'Exit: ' + job.exit_code)
                  : null
              );
            })
          )
    );
  }

  // -------------------------------------------------------------------------
  // LogsPanel
  // -------------------------------------------------------------------------
  function LogsPanel(props) {
    const lines = props.logs || [];
    const ref = useRef(null);

    useEffect(function () {
      if (ref.current) {
        ref.current.scrollTop = ref.current.scrollHeight;
      }
    }, [lines.length]);

    return h('div', { className: 'hc-panel' },
      h('div', { className: 'hc-panel-title' }, 'Dev Server Logs'),
      h('div', { ref: ref, className: 'hc-logs' },
        lines.length === 0
          ? 'No logs yet...'
          : lines.join('\n')
      )
    );
  }

  // -------------------------------------------------------------------------
  // CanvasPage (Main)
  // -------------------------------------------------------------------------
  function CanvasPage() {
    useEffect(function () {
      installCanvasThemeReset();
    }, []);

    const [projectPath, setProjectPath] = useState(null);
    const [devServerRunning, setDevServerRunning] = useState(false);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [logs, setLogs] = useState([]);
    const [jobs, setJobs] = useState({});
    const [selectedElement, setSelectedElement] = useState(null);
    const [selectionMode, setSelectionMode] = useState(false);
    const [hasNode, setHasNode] = useState(true);
    const [hasNpm, setHasNpm] = useState(true);
    const [clearingActivity, setClearingActivity] = useState(false);
    const [defaultProjectParent, setDefaultProjectParent] = useState('');
    const [currentJobId, setCurrentJobId] = useState(null);
    const [jobStatus, setJobStatus] = useState(null);
    const iframeRef = useRef(null);
    const statusInterval = useRef(null);
    const logsInterval = useRef(null);
    const jobStatusInterval = useRef(null);
    const prevPhaseRef = useRef(null);

    // Poll status
    const fetchStatus = useCallback(function () {
      getJSON('/status')
        .then(function (data) {
          if (!data.ok) return;
          setProjectPath(data.project_path || null);
          setDevServerRunning(!!data.dev_server_running);
          setPreviewUrl(data.dev_preview_url || null);
          setJobs(data.agent_jobs || {});
          setHasNode(!!data.has_node);
          setHasNpm(!!data.has_npm);
          setDefaultProjectParent(data.default_project_parent || '');
        })
        .catch(function (err) {
          console.error('Status poll failed:', err);
        });
    }, []);

    // Poll logs
    const fetchLogs = useCallback(function () {
      getJSON('/dev/logs')
        .then(function (data) {
          if (data.ok && Array.isArray(data.lines)) {
            setLogs(data.lines);
          }
        })
        .catch(function () {});
    }, []);

    useEffect(function () {
      fetchStatus();
      statusInterval.current = setInterval(fetchStatus, 3000);
      logsInterval.current = setInterval(fetchLogs, 2000);
      return function () {
        clearInterval(statusInterval.current);
        clearInterval(logsInterval.current);
      };
    }, [fetchStatus, fetchLogs]);

    // Poll the current job's /agent/status/{job_id} for phase, and reload the
    // preview exactly once on the transition into done_ok.
    const fetchJobStatus = useCallback(function (jobId) {
      getJSON('/agent/status/' + jobId)
        .then(function (data) {
          if (!data || !data.ok) return;
          checkStatusFieldContract(data);
          setJobStatus(data);
          if (prevPhaseRef.current !== 'done_ok' && data.phase === 'done_ok') {
            reloadPreviewOnce();
          }
          prevPhaseRef.current = data.phase;
        })
        .catch(function (err) {
          console.error('Job status poll failed:', err);
        });
    }, []);

    useEffect(function () {
      if (!currentJobId) return undefined;
      fetchJobStatus(currentJobId);
      jobStatusInterval.current = setInterval(function () { fetchJobStatus(currentJobId); }, 3000);
      return function () { clearInterval(jobStatusInterval.current); };
    }, [currentJobId, fetchJobStatus]);

    // Listen for postMessage from iframe (selection)
    useEffect(function () {
      function onMessage(event) {
        if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
        if (previewUrl && event.origin !== getOrigin(previewUrl)) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'HERMES_CANVAS_SELECTION') {
          setSelectedElement(data.payload || null);
          setSelectionMode(false);
        } else if (data.type === 'HERMES_CANVAS_SELECTION_STATE') {
          setSelectionMode(!!data.active);
        }
      }
      window.addEventListener('message', onMessage);
      return function () { window.removeEventListener('message', onMessage); };
    }, [previewUrl]);

    // Toggle selection mode
    const toggleSelection = useCallback(function () {
      const next = !selectionMode;
      setSelectionMode(next);
      if (iframeRef.current && iframeRef.current.contentWindow) {
        iframeRef.current.contentWindow.postMessage(
          { type: next ? 'HERMES_CANVAS_SELECTION_ON' : 'HERMES_CANVAS_SELECTION_OFF' },
          getOrigin(previewUrl)
        );
      }
    }, [selectionMode, previewUrl]);

    // Notify iframe of selection mode changes
    useEffect(function () {
      if (iframeRef.current && iframeRef.current.contentWindow) {
        iframeRef.current.contentWindow.postMessage(
          { type: selectionMode ? 'HERMES_CANVAS_SELECTION_ON' : 'HERMES_CANVAS_SELECTION_OFF' },
          getOrigin(previewUrl)
        );
      }
    }, [selectionMode, previewUrl]);

    const onProjectChange = useCallback(function (path) {
      setProjectPath(path);
      fetchStatus();
    }, [fetchStatus]);

    const onJobStarted = useCallback(function (jobId) {
      prevPhaseRef.current = null;
      setJobStatus(null);
      setCurrentJobId(jobId);
      fetchStatus();
    }, [fetchStatus]);

    const onStatusChange = useCallback(function () {
      fetchStatus();
      fetchLogs();
    }, [fetchStatus, fetchLogs]);

    const onClearAgentActivity = useCallback(function () {
      setClearingActivity(true);
      postJSON('/agent/clear', {})
        .then(function (data) {
          if (data && data.ok) {
            setJobs(data.agent_jobs || {});
          } else {
            fetchStatus();
          }
        })
        .catch(function (err) {
          alert('Failed to clear activity: ' + text(err.message, 'Unknown error'));
        })
        .finally(function () { setClearingActivity(false); });
    }, [fetchStatus]);

    // Check prerequisites
    if (!hasNode || !hasNpm) {
      console.warn('Hermes Canvas: Node.js/npm not available; project creation and Vite projects may fail, but static HTML projects can still be opened.');
    }

    return h('div', { className: 'hc-root', style: { background: 'var(--ui-chat-surface-background)' } },
      // Left Sidebar
      h('div', { className: 'hc-sidebar', style: { background: 'var(--ui-chat-surface-background)', borderRight: '1px solid var(--dt-border)' } },
        h(ProjectPanel, {
          projectPath: projectPath,
          defaultProjectParent: defaultProjectParent,
          onProjectChange: onProjectChange
        }),
        h(DevServerPanel, {
          projectPath: projectPath,
          devServerRunning: devServerRunning,
          previewUrl: previewUrl,
          iframeRef: iframeRef,
          onStatusChange: onStatusChange
        }),
        h(PromptPanel, {
          projectPath: projectPath,
          selectedElement: selectedElement,
          onJobStarted: onJobStarted
        }),
        h(SelectionPanel, {
          selectedElement: selectedElement,
          onClear: function () { setSelectedElement(null); }
        }),
        h(PhaseStepperPanel, {
          phase: jobStatus && jobStatus.phase,
          authError: !!(jobStatus && jobStatus.auth_error),
          targetFile: jobStatus && jobStatus.target_file
        }),
        h(AgentJobsPanel, {
          jobs: jobs,
          clearing: clearingActivity,
          onClear: onClearAgentActivity
        }),
        h(LogsPanel, { logs: logs })
      ),
      // Right Preview
      h('div', { className: 'hc-preview', style: { background: 'var(--ui-chat-surface-background)' } },
        h('div', { className: 'hc-preview-toolbar', style: { background: 'var(--ui-chat-surface-background)', borderBottom: '1px solid var(--dt-border)' } },
          h('span', { className: 'hc-panel-title' }, 'Preview'),
          h('div', { style: { flex: 1 } }),
          h(Button, {
            className: join('hc-btn', selectionMode && 'hc-btn-primary'),
            onClick: toggleSelection
          }, selectionMode ? 'Exit Selection' : 'Select Element'),
          h(Button, {
            className: 'hc-btn',
            onClick: function () {
              if (previewUrl) {
                window.open(previewUrl, '_blank', 'noopener,noreferrer');
              }
            },
            disabled: !previewUrl
          }, 'Open in Browser'),
          h(Button, {
            className: 'hc-btn',
            onClick: function () {
              if (previewUrl && iframeRef.current) {
                iframeRef.current.src = previewUrl;
              }
            },
            disabled: !previewUrl
          }, 'Refresh')
        ),
        previewUrl
          ? h('iframe', {
              ref: iframeRef,
              className: 'hc-preview-frame',
              src: previewUrl,
              sandbox: 'allow-scripts allow-same-origin allow-forms'
            })
          : h('div', { className: 'hc-empty' }, 'Start the dev server to see the preview')
      )
    );
  }

  // -------------------------------------------------------------------------
  // Mount
  // -------------------------------------------------------------------------
  if (window.__HERMES_PLUGINS__ && window.__HERMES_PLUGINS__.register) {
    window.__HERMES_PLUGINS__.register('hermes-canvas', CanvasPage);
  } else {
    console.error('Hermes Canvas: plugin registry not available');
  }
})();
