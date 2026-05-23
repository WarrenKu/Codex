(function () {
  const search = decodeURIComponent(String(window.location.search || ""));
  const pathname = decodeURIComponent(String(window.location.pathname || ""));
  const match = pathname.match(/^\/admin\/([a-z0-9-]+)\.([a-z0-9_#-]+)$/i)
    || search.match(/^\?\/admin\/([a-z0-9-]+)\.([a-z0-9_#-]+)$/i);
  if (!match) {
    return;
  }

  const routePage = String(match[1] || "dash").toLowerCase();
  const routeOwner = String(match[2] || "owner").trim().toLowerCase();
  const trustedUser = String(localStorage.getItem("trusted_user") || "").trim().toLowerCase();
  const trustedRole = String(localStorage.getItem("trusted_role") || "").trim().toLowerCase();
  const sessionToken = String(localStorage.getItem("session_token") || "").trim();

  if (!trustedUser || !sessionToken || trustedRole !== "owner" || trustedUser !== routeOwner) {
    window.location.replace("/");
    return;
  }

  document.body.classList.add("admin-loading-data");

  const pageMap = {
    dash: "dash",
    user: "user",
    users: "user",
    add: "add",
    profile: "profile"
  };

  let adminDataCache = null;
  let profileDataCache = null;

  function buildAdminRoute(page) {
    const safePage = pageMap[page] || "dash";
    return `/admin/${safePage}.${routeOwner}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getInitial(value) {
    return String(value || "X").trim().charAt(0).toUpperCase() || "X";
  }

  function getUsersFromData(data) {
    if (Array.isArray(data?.users)) {
      return data.users;
    }
    return Object.values(data?.roles || {}).flat();
  }

  function formatDate(value) {
    return value ? String(value) : "-";
  }

  function formatRole(value) {
    const raw = String(value || "visitor").trim();
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Visitor";
  }

  function buildPublicProfileUrl(username = "") {
    const safeUser = String(username || "").trim().replace(/^@+/, "");
    return safeUser ? `${window.location.origin}/?/@${encodeURIComponent(safeUser)}` : window.location.origin;
  }

  function injectAdminEnhancements() {
    if (document.getElementById("admin-xwb-style")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "admin-xwb-style";
    style.textContent = `
      body.admin-loading-data .page-heading,
      body.admin-loading-data .metric-card,
      body.admin-loading-data .panel,
      body.admin-loading-data .sidebar-user,
      body.admin-loading-data .profile-button {
        opacity: 0;
        transform: translateY(12px);
        pointer-events: none;
      }
      body.admin-ready .page-heading,
      body.admin-ready .metric-card,
      body.admin-ready .panel,
      body.admin-ready .sidebar-user,
      body.admin-ready .profile-button {
        opacity: 1;
        transform: none;
        pointer-events: auto;
        transition: opacity .28s ease, transform .28s ease;
      }
      #admin-chart-bars {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        align-items: end;
        gap: 14px;
        min-height: 260px;
      }
      .chart-column-live {
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        animation: adminBarIn .55s cubic-bezier(.16,1,.3,1) both;
      }
      .chart-column-live span {
        width: 100%;
        min-height: 22px;
        border-radius: 12px 12px 4px 4px;
        transition: height .45s cubic-bezier(.16,1,.3,1);
      }
      .chart-column-live strong {
        font-size: 13px;
        font-weight: 700;
        color: #dbe7ff;
        line-height: 1;
      }
      .chart-column-live small {
        font-size: 12px;
        font-weight: 600;
        color: #9fb5de;
      }
      .chart-column-live em {
        font-style: normal;
        font-size: 11px;
        line-height: 1.35;
        text-align: center;
        color: #7e93bb;
      }
      .metric-card .metric-icon {
        border: 1px solid rgba(255,255,255,.08);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
      }
      .metric-card.metric-primary .metric-icon {
        background: linear-gradient(135deg, rgba(93,168,255,.22), rgba(80,106,255,.14));
        color: #8fc3ff;
      }
      .metric-card.metric-success .metric-icon {
        background: linear-gradient(135deg, rgba(61,230,212,.2), rgba(34,197,94,.12));
        color: #7ef0de;
      }
      .metric-card.metric-warning .metric-icon {
        background: linear-gradient(135deg, rgba(255,205,86,.22), rgba(255,154,65,.12));
        color: #ffd97b;
      }
      .metric-card.metric-danger .metric-icon {
        background: linear-gradient(135deg, rgba(255,123,155,.2), rgba(255,86,86,.12));
        color: #ffb2c6;
      }
      .sidebar-user .avatar-img,
      .profile-button .avatar-img {
        border: 0;
        box-shadow: none;
      }
      .admin-profile-cover-wrap,
      .admin-profile-avatar-wrap {
        position: relative;
      }
      .admin-profile-avatar-wrap {
        display: inline-flex;
        justify-content: center;
      }
      .admin-media-edit-btn {
        position: absolute;
        opacity: 0;
        transform: translateY(4px) scale(.96);
        transition: opacity .18s ease, transform .18s ease;
        z-index: 8;
      }
      .admin-profile-cover-wrap:hover .admin-media-edit-btn,
      .admin-profile-avatar-wrap:hover .admin-media-edit-btn,
      .admin-profile-cover-wrap:focus-within .admin-media-edit-btn,
      .admin-profile-avatar-wrap:focus-within .admin-media-edit-btn {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      .admin-cover-edit-btn {
        top: 12px;
        right: 12px;
      }
      .admin-avatar-edit-btn {
        right: -4px;
        bottom: 8px;
        border-radius: 999px;
        width: 34px;
        height: 34px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .admin-profile-handle-wrap {
        position: relative;
        display: inline-flex;
        justify-content: center;
      }
      .admin-profile-handle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        transition: transform .18s ease, opacity .18s ease;
      }
      .admin-profile-handle:hover {
        transform: translateY(-1px);
        opacity: .96;
      }
      .admin-profile-handle-panel {
        position: absolute;
        bottom: calc(100% - 2px);
        left: 50%;
        transform: translate(-50%, 2px);
        min-width: 138px;
        padding: 6px;
        border-radius: 11px;
        background: rgba(18, 27, 45, .98);
        border: 1px solid rgba(150, 177, 221, .18);
        box-shadow: 0 18px 40px rgba(0,0,0,.34);
        opacity: 0;
        pointer-events: none;
        transition: opacity .2s ease, transform .2s ease;
        z-index: 30;
      }
      .admin-profile-handle-panel::before {
        content: "";
        position: absolute;
        bottom: -5px;
        left: 50%;
        width: 10px;
        height: 10px;
        background: rgba(18, 27, 45, .98);
        border-right: 1px solid rgba(150, 177, 221, .18);
        border-bottom: 1px solid rgba(150, 177, 221, .18);
        transform: translateX(-50%) rotate(45deg);
      }
      .admin-profile-handle-panel.show {
        opacity: 1;
        pointer-events: auto;
        transform: translate(-50%, 0);
      }
      .admin-profile-handle-btn {
        width: 100%;
        border: 0;
        border-radius: 9px;
        padding: 8px 11px;
        background: linear-gradient(135deg, #2d7dff, #68a4ff);
        color: #fff;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: .01em;
      }
      .admin-profile-handle-wrap:hover .admin-profile-handle-panel,
      .admin-profile-handle-wrap:focus-within .admin-profile-handle-panel {
        opacity: 1;
        pointer-events: auto;
        transform: translate(-50%, 0);
      }
      @keyframes adminBarIn {
        from { opacity: 0; transform: translateY(22px) scaleY(.82); filter: blur(10px); }
        to { opacity: 1; transform: translateY(0) scaleY(1); filter: blur(0); }
      }
      @media (max-width: 1100px) {
        #admin-chart-bars {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
      }
      @media (max-width: 640px) {
        #admin-chart-bars {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    `;
    document.head.appendChild(style);
  }

  function withOwnerRoute() {
    document.querySelectorAll("a[href]").forEach((link) => {
      const href = String(link.getAttribute("href") || "").trim();
      if (!href || href.startsWith("http") || href.startsWith("#")) {
        return;
      }
      if (href.endsWith("index.html")) {
        link.setAttribute("href", buildAdminRoute("dash"));
      } else if (href.endsWith("users.html")) {
        link.setAttribute("href", buildAdminRoute("user"));
      } else if (href.endsWith("add-user.html")) {
        link.setAttribute("href", buildAdminRoute("add"));
      } else if (href.endsWith("profile.html")) {
        link.setAttribute("href", buildAdminRoute("profile"));
      } else if (href.endsWith("login.html")) {
        link.setAttribute("href", "/");
      } else if (
        href.endsWith("charts.html") ||
        href.endsWith("tables.html") ||
        href.endsWith("forms.html") ||
        href.endsWith("components.html") ||
        href.endsWith("alerts.html") ||
        href.endsWith("modals.html") ||
        href.endsWith("settings.html") ||
        href.endsWith("blank.html") ||
        href.endsWith("user-details.html")
      ) {
        link.setAttribute("href", buildAdminRoute("dash"));
      }
    });
  }

  function replaceAvatarImages(displayName, avatarUrl = "") {
    const safeUrl = String(avatarUrl || "").trim();
    document.querySelectorAll(".sidebar-user .avatar-img, .profile-button .avatar-img").forEach((node) => {
      const existing = node.tagName === "SPAN" ? node : null;
      const badge = existing || document.createElement("span");
      badge.className = node.className;
      badge.style.display = "inline-flex";
      badge.style.alignItems = "center";
      badge.style.justifyContent = "center";
      badge.style.fontWeight = "700";
      badge.style.borderRadius = "14px";
      if (safeUrl) {
        badge.style.background = `url("${safeUrl}") center / cover no-repeat`;
        badge.style.color = "transparent";
        badge.textContent = getInitial(displayName);
      } else {
        badge.style.background = "linear-gradient(135deg, #5da8ff, #7c9dff)";
        badge.style.color = "#fff";
        badge.textContent = getInitial(displayName);
      }
      if (!existing) {
        node.replaceWith(badge);
      }
    });
  }

  function hydrateChrome() {
    const listProfile = getUsersFromData(adminDataCache).find((item) => String(item.user || "").toLowerCase() === trustedUser);
    const profile = profileDataCache || listProfile || null;
    const displayName = String(profile?.displayName || trustedUser || routeOwner);
    const handle = `@${String(profile?.user || trustedUser || routeOwner)}`;

    document.querySelectorAll(".brand-title").forEach((el) => {
      el.textContent = "SitusXWb";
    });
    document.querySelectorAll(".brand-subtitle").forEach((el) => {
      el.textContent = "Xenon Admin";
    });
    document.querySelectorAll(".profile-name, .sidebar-user strong").forEach((el) => {
      el.textContent = displayName;
    });
    document.querySelectorAll(".sidebar-user small").forEach((el) => {
      el.textContent = handle;
    });
    replaceAvatarImages(displayName, profile?.avatarUrl || "");

    const sidebarToggle = document.querySelector("[data-sidebar-toggle]");
    const sidebarClose = document.querySelector("[data-sidebar-close]");
    const shell = document.querySelector(".admin-shell");
    sidebarToggle?.addEventListener("click", () => shell?.classList.toggle("sidebar-open"));
    sidebarClose?.addEventListener("click", () => shell?.classList.remove("sidebar-open"));

    document.querySelectorAll(".dropdown-toggle").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
      });
    });

    document.querySelectorAll(".dropdown-item").forEach((link) => {
      const label = String(link.textContent || "").trim().toLowerCase();
      if (label === "profile") {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          window.location.href = buildAdminRoute("profile");
        });
      } else if (label === "account settings") {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          window.location.href = "/";
        });
      } else if (label === "sign out") {
        link.setAttribute("href", "/");
        link.addEventListener("click", (event) => {
          event.preventDefault();
          localStorage.removeItem("trusted_user");
          localStorage.removeItem("trusted_role");
          localStorage.removeItem("session_token");
          window.location.href = "/";
        });
      }
    });
  }

  function renderProfile(profile) {
    if (!profile) {
      return;
    }
    const nickname = String(profile.displayName || profile.user || trustedUser);
    const username = String(profile.user || trustedUser);
    const liveProfile = getUsersFromData(adminDataCache).find((item) => String(item.user || "").toLowerCase() === username) || {};
    const handle = `@${username}`;
    const telegramId = String(profile.telegram || "-") || "-";
    const role = formatRole(profile.role);
    const online = !!liveProfile.online;
    const statusLabel = online ? "Online" : "Offline";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok";
    const bio = String(profile.bio || "Belum ada deskripsi user.");

    const textMap = [
      ["#admin-profile-display-name", nickname],
      ["#admin-profile-username", handle],
      ["#admin-profile-role-badge", role],
      ["#admin-profile-status-badge", statusLabel],
      ["#admin-profile-tele-card", telegramId],
      ["#admin-profile-role-card", role],
      ["#admin-profile-timezone-card", timezone]
    ];
    textMap.forEach(([selector, value]) => {
      const el = document.querySelector(selector);
      if (el) {
        el.textContent = value;
      }
    });

    const profileName = document.getElementById("profileName");
    const profileTelegram = document.getElementById("profileTelegram");
    const profileUsername = document.getElementById("profileUsername");
    const profileRole = document.getElementById("profileRole");
    const profileBio = document.getElementById("profileBio");
    const avatarImage = document.getElementById("admin-profile-avatar-image");
    const coverImage = document.getElementById("admin-profile-cover-image");
    if (profileName) profileName.value = nickname;
    if (profileTelegram) profileTelegram.value = telegramId;
    if (profileUsername) profileUsername.value = handle;
    if (profileRole) profileRole.value = role;
    if (profileBio) profileBio.value = bio;
    if (avatarImage && profile.avatarUrl) {
      avatarImage.src = profile.avatarUrl;
    }
    if (coverImage && profile.coverUrl) {
      coverImage.src = profile.coverUrl;
    }
    const statusBadge = document.getElementById("admin-profile-status-badge");
    if (statusBadge) {
      statusBadge.className = `badge ${online ? "text-bg-success" : "text-bg-secondary"}`;
    }

    const handleEl = document.getElementById("admin-profile-username");
    if (handleEl && !handleEl.dataset.handleBound) {
      handleEl.dataset.handleBound = "true";
      handleEl.classList.add("admin-profile-handle");
      const wrap = document.createElement("span");
      wrap.className = "admin-profile-handle-wrap";
      handleEl.parentNode.insertBefore(wrap, handleEl);
      wrap.appendChild(handleEl);
      const panel = document.createElement("div");
      panel.className = "admin-profile-handle-panel";
      panel.innerHTML = '<button type="button" class="admin-profile-handle-btn">Salin user</button>';
      wrap.appendChild(panel);
      panel.querySelector(".admin-profile-handle-btn")?.addEventListener("click", async () => {
        const link = buildPublicProfileUrl(username);
        const button = panel.querySelector(".admin-profile-handle-btn");
        try {
          await navigator.clipboard.writeText(link);
          if (button) {
            button.textContent = "Link user disalin";
          }
          setTimeout(() => {
            if (button) {
              button.textContent = "Salin user";
            }
          }, 1100);
        } catch {
          window.prompt("Salin link user ini:", link);
        }
      });
    }

    const bindMediaUploader = (buttonId, inputId, target, previewEl) => {
      const trigger = document.getElementById(buttonId);
      const input = document.getElementById(inputId);
      if (!trigger || !input || !previewEl || input.dataset.mediaBound) {
        return;
      }
      input.dataset.mediaBound = "true";
      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        input.click();
      });
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) {
          return;
        }
        if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) {
          window.alert("Gunakan gambar PNG, JPG, atau WEBP.");
          input.value = "";
          return;
        }
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const response = await fetch("/api/profile/media", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                user: trustedUser,
                sessionToken,
                target,
                dataUrl: reader.result
              })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(result.message || "Upload gambar gagal.");
            }
            if (result.profile) {
              profileDataCache = result.profile;
              renderProfile(profileDataCache);
              hydrateChrome();
            }
          } catch (error) {
            window.alert(error.message || "Upload gambar gagal.");
          } finally {
            input.value = "";
          }
        };
        reader.readAsDataURL(file);
      });
    };
    bindMediaUploader("admin-avatar-edit-btn", "admin-avatar-file-input", "avatar", avatarImage);
    bindMediaUploader("admin-cover-edit-btn", "admin-cover-file-input", "cover", coverImage);

    const form = document.getElementById("admin-profile-form");
    if (form && !form.dataset.boundProfile) {
      form.dataset.boundProfile = "true";
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const updates = [];
        const nextNickname = String(profileName?.value || "").trim();
        const nextBio = String(profileBio?.value || "").trim();
        if (nextNickname && nextNickname !== nickname) {
          updates.push({ field: "display_name", value: nextNickname });
        }
        if (nextBio && nextBio !== bio) {
          updates.push({ field: "bio", value: nextBio });
        }
        if (!updates.length) {
          return;
        }
        const saveButton = document.getElementById("admin-profile-save");
        const original = saveButton?.innerHTML || "";
        if (saveButton) {
          saveButton.disabled = true;
          saveButton.innerHTML = '<i class="bi bi-arrow-repeat" aria-hidden="true"></i> Saving...';
        }
        try {
          for (const update of updates) {
            const response = await fetch("/api/profile/update", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                user: trustedUser,
                sessionToken,
                field: update.field,
                value: update.value
              })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(result.message || "Update profile gagal.");
            }
            if (result.profile) {
              profileDataCache = result.profile;
            }
          }
          hydrateChrome();
          renderProfile(profileDataCache || profile);
        } catch (error) {
          window.alert(error.message || "Update profile gagal.");
        } finally {
          if (saveButton) {
            saveButton.disabled = false;
            saveButton.innerHTML = original;
          }
        }
      });
    }
  }

  function updateMetricCard(card, value, metaA, metaB) {
    if (!card) {
      return;
    }
    const valueEl = card.querySelector(".metric-value");
    const metaParts = card.querySelectorAll(".metric-meta span");
    if (valueEl) {
      valueEl.textContent = value;
    }
    if (metaParts[0]) {
      metaParts[0].textContent = metaA;
    }
    if (metaParts[1]) {
      metaParts[1].textContent = metaB;
    }
  }

  function renderDash(data) {
    const users = getUsersFromData(data);
    const chart = Array.isArray(data.chart) ? data.chart : [];
    const timeline = Array.isArray(data.visitsTimeline) ? data.visitsTimeline : [];
    const onlineUsers = users.filter((item) => item.online).length;
    const alertUsers = users.filter((item) => ["blocked", "hold", "deleted"].includes(String(item.status || "").toLowerCase())).length;
    const totalUsers = Number(data.totalUsers || users.length || 0);
    const totalRoleKinds = Array.isArray(chart) ? chart.length : 0;

    updateMetricCard(document.querySelector('[data-admin-metric="users"]'), String(totalUsers), `${onlineUsers} aktif`, "workspace user");
    updateMetricCard(document.querySelector('[data-admin-metric="roles"]'), String(totalRoleKinds), chart[0] ? chart[0].label : "visitor", "role terdeteksi");
    updateMetricCard(document.querySelector('[data-admin-metric="online"]'), String(onlineUsers), `${totalUsers ? Math.round((onlineUsers / totalUsers) * 100) : 0}%`, "sedang online");
    updateMetricCard(document.querySelector('[data-admin-metric="alerts"]'), String(alertUsers), alertUsers ? "butuh review" : "aman", "status kritis");

    const chartBars = document.getElementById("admin-chart-bars");
    if (chartBars) {
      const max = Math.max(...timeline.map((item) => Number(item.visits || 0)), 1);
      chartBars.innerHTML = timeline.map((item, index) => {
        const height = Math.max(20, Math.round((Number(item.visits || 0) / max) * 100));
        const narrative = item.visits <= 0 ? "belum ada visit" : `${item.visits} visit · ${item.uniqueUsers} user`;
        return `<div class="chart-column chart-column-live" style="animation-delay:${index * 90}ms" title="${escapeHtml(item.fullLabel)}">
          <span style="height:${height}%"></span>
          <strong>${escapeHtml(String(item.visits))}</strong>
          <small>${escapeHtml(item.shortLabel)}</small>
          <em>${escapeHtml(narrative)}</em>
        </div>`;
      }).join("");
    }

    const activityList = document.getElementById("admin-activity-list");
    if (activityList) {
      const topRole = chart[0];
      const peakDay = [...timeline].sort((a, b) => Number(b.visits || 0) - Number(a.visits || 0))[0];
      activityList.innerHTML = `
        <div class="activity-item"><span class="activity-dot bg-primary"></span><div><p class="mb-1 fw-semibold">${totalUsers} user terdeteksi</p><p class="text-muted small mb-0">${onlineUsers} user sedang online di workspace saat ini.</p></div></div>
        <div class="activity-item"><span class="activity-dot bg-success"></span><div><p class="mb-1 fw-semibold">Role ${escapeHtml(topRole?.label || "Visitor")} paling ramai</p><p class="text-muted small mb-0">${escapeHtml(String(topRole?.total || 0))} user berada di role ${escapeHtml(topRole?.label || "Visitor")}.</p></div></div>
        <div class="activity-item"><span class="activity-dot bg-info"></span><div><p class="mb-1 fw-semibold">Hari tersibuk: ${escapeHtml(peakDay?.fullLabel || "-")}</p><p class="text-muted small mb-0">${peakDay ? `${peakDay.visits} kunjungan tercatat dari ${peakDay.uniqueUsers} user berbeda.` : "Belum ada data kunjungan."}</p></div></div>
        <div class="activity-item"><span class="activity-dot bg-warning"></span><div><p class="mb-1 fw-semibold">${alertUsers ? `${alertUsers} alert aktif` : "Belum ada alert kritis"}</p><p class="text-muted small mb-0">${alertUsers ? "Cek user yang kena block, hold, atau delete status." : "Semua status masih relatif aman tanpa alert kritis."}</p></div></div>
      `;
    }

    const recentUsers = document.getElementById("admin-recent-users");
    if (recentUsers) {
      recentUsers.innerHTML = users.slice(0, 8).map((item) => `
        <tr>
          <td>
            <div class="d-flex align-items-center gap-2">
              <span class="avatar-img avatar-sm d-inline-flex align-items-center justify-content-center" style="background:linear-gradient(135deg,#5da8ff,#7c9dff);color:#fff;font-weight:700;">${escapeHtml(getInitial(item.displayName || item.user))}</span>
              <div>
                <p class="fw-semibold mb-0">${escapeHtml(item.displayName || item.user)}</p>
                <p class="text-muted small mb-0">@${escapeHtml(item.user || "-")}</p>
              </div>
            </div>
          </td>
          <td>${escapeHtml(item.role || "visitor")}</td>
          <td>${escapeHtml(item.tele || "-")}</td>
          <td><span class="badge ${item.online ? "text-bg-success" : "text-bg-secondary"}">${item.online ? "Online" : escapeHtml(item.status || "Offline")}</span></td>
          <td>${escapeHtml(formatDate(item.lastLogin || item.registeredAt))}</td>
          <td class="text-end"><a class="btn btn-light btn-sm" href="${buildAdminRoute("user")}">View</a></td>
        </tr>
      `).join("");
    }

    document.getElementById("admin-dash-add-user")?.addEventListener("click", () => {
      window.location.href = buildAdminRoute("add");
    });
  }

  function renderUsers(data) {
    const users = getUsersFromData(data);
    const tableBody = document.querySelector("table tbody");
    if (!tableBody) {
      return;
    }
    tableBody.innerHTML = users.map((item) => `
      <tr>
        <td>
          <div class="d-flex align-items-center gap-2">
            <span class="avatar-img avatar-sm d-inline-flex align-items-center justify-content-center" style="background:linear-gradient(135deg,#5da8ff,#7c9dff);color:#fff;font-weight:700;">${escapeHtml(getInitial(item.displayName || item.user))}</span>
            <div>
              <p class="fw-semibold mb-0">${escapeHtml(item.displayName || item.user)}</p>
              <p class="text-muted small mb-0">@${escapeHtml(item.user || "-")}</p>
            </div>
          </div>
        </td>
        <td>${escapeHtml(item.role || "visitor")}</td>
        <td>${escapeHtml(item.tele || "-")}</td>
        <td><span class="badge ${item.online ? "text-bg-success" : "text-bg-secondary"}">${item.online ? "Online" : escapeHtml(item.status || "Offline")}</span></td>
        <td>${escapeHtml(formatDate(item.registeredAt))}</td>
        <td class="text-end"><button class="btn btn-light btn-sm" type="button">View</button></td>
      </tr>
    `).join("");

    const activeCount = users.filter((item) => item.online || String(item.status || "").toLowerCase() === "success").length;
    const pendingCount = users.filter((item) => String(item.status || "").toLowerCase() === "pending").length;
    const suspendedCount = users.filter((item) => ["blocked", "hold", "deleted"].includes(String(item.status || "").toLowerCase())).length;
    updateMetricCard(document.querySelector(".metric-card.metric-primary"), String(users.length), `${users.filter((item) => item.role === "visitor").length} visitor`, "akun terdaftar");
    updateMetricCard(document.querySelector(".metric-card.metric-success"), String(activeCount), `${users.length ? Math.round((activeCount / users.length) * 100) : 0}%`, "akun sehat");
    updateMetricCard(document.querySelector(".metric-card.metric-warning"), String(pendingCount), pendingCount ? "perlu cek" : "aman", "status pending");
    updateMetricCard(document.querySelector(".metric-card.metric-danger"), String(suspendedCount), suspendedCount ? "perlu review" : "nihil", "akun bermasalah");
  }

  function initAddUserPage() {
    if (routePage !== "add") {
      return;
    }
    const form = document.querySelector("form.needs-validation");
    const firstName = document.getElementById("firstName");
    const lastName = document.getElementById("lastName");
    const email = document.getElementById("email");
    const phone = document.getElementById("phone");
    const role = document.getElementById("role");
    const team = document.getElementById("team");
    const notes = document.getElementById("notes");
    if (!form || !firstName || !lastName || !email || !phone || !role || !team || !notes) {
      return;
    }

    firstName.previousElementSibling.textContent = "Username";
    firstName.placeholder = "Masukkan username";
    lastName.previousElementSibling.textContent = "Display Name";
    lastName.placeholder = "Nama tampilan";
    email.previousElementSibling.textContent = "Password";
    email.type = "text";
    email.placeholder = "Masukkan password";
    phone.previousElementSibling.textContent = "Telegram";
    phone.placeholder = "ID / username Telegram";
    role.previousElementSibling.textContent = "Role";
    role.innerHTML = '<option value="visitor">visitor</option><option value="owner">owner</option><option value="costume">costume</option>';
    team.previousElementSibling.textContent = "Custom Role";
    team.innerHTML = '<option value="">Pilih jika perlu</option>';
    notes.previousElementSibling.textContent = "Bio";
    notes.placeholder = "Opsional bio user";

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {
        user: firstName.value.trim(),
        password: email.value.trim(),
        telegram: phone.value.trim(),
        role: role.value,
        customRole: team.value.trim()
      };
      const response = await fetch("/api/admin/add-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        window.alert(result.message || "Add user gagal.");
        return;
      }
      window.location.href = buildAdminRoute("user");
    });
  }

  async function loadDashboardData() {
    const response = await fetch("/api/dashboard");
    if (!response.ok) {
      throw new Error("Dashboard gagal dimuat.");
    }
    return response.json();
  }

  async function loadProfileData() {
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: trustedUser,
        sessionToken
      })
    });
    if (!response.ok) {
      throw new Error("Profile admin gagal dimuat.");
    }
    const data = await response.json();
    return data?.profile || null;
  }

  async function init() {
    injectAdminEnhancements();
    withOwnerRoute();
    initAddUserPage();
    if (routePage === "dash" || routePage === "user" || routePage === "users" || routePage === "profile") {
      try {
        adminDataCache = await loadDashboardData();
        if (routePage === "profile") {
          profileDataCache = await loadProfileData();
        }
        hydrateChrome();
        if (routePage === "dash") {
          renderDash(adminDataCache);
        } else if (routePage === "profile") {
          renderProfile(profileDataCache);
        } else {
          renderUsers(adminDataCache);
        }
      } catch (error) {
        console.error(error);
      } finally {
        document.body.classList.remove("admin-loading-data");
        document.body.classList.add("admin-ready");
      }
    } else {
      hydrateChrome();
      document.body.classList.remove("admin-loading-data");
      document.body.classList.add("admin-ready");
    }
  }

  init();
})();
