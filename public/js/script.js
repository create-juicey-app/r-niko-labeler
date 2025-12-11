document.addEventListener('DOMContentLoaded', () => {
  fetchStats();
  fetchUsers();
  
  // Refresh stats every 5 seconds
  setInterval(fetchStats, 5000);

  const reprocessBtn = document.getElementById('reprocess-btn');
  if (reprocessBtn) {
    reprocessBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to force re-processing? This will re-emit all labels.')) return;
      try {
        reprocessBtn.disabled = true;
        reprocessBtn.textContent = 'Starting...';
        const res = await fetch('/api/reprocess', { method: 'POST' });
        if (res.ok) {
          alert('Reprocessing started.');
          fetchStats();
        } else {
          alert('Failed to start reprocessing: ' + await res.text());
        }
      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        reprocessBtn.disabled = false;
        reprocessBtn.textContent = 'Force Reprocess';
      }
    });
  }
});

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    
    const statusBadge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');
    
    if (data.isProcessing) {
      statusBadge.className = 'status-badge status-processing';
      statusText.textContent = '● Processing Active';
    } else {
      statusBadge.className = 'status-badge status-idle';
      statusText.textContent = '● Idle / Watching';
    }
    
    document.getElementById('stat-users').textContent = data.processedUsers;
    document.getElementById('stat-followers').textContent = data.processedFollowers;
  } catch (e) {
    console.error("Failed to fetch stats", e);
  }
}

async function fetchUsers() {
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    
    renderList('artists-list', data.artists);
    renderList('engagers-list', data.engagers);
  } catch (e) {
    console.error("Failed to fetch users", e);
  }
}

function renderList(elementId, users) {
  const list = document.getElementById(elementId);
  list.innerHTML = '';
  
  users.forEach(user => {
    const li = document.createElement('li');
    li.className = 'user-item';
    
    // Make clickable
    const link = document.createElement('a');
    link.href = `https://bsky.app/profile/${user.handle || user.did}`;
    link.target = "_blank";
    link.style.display = "flex";
    link.style.alignItems = "center";
    link.style.width = "100%";
    link.style.textDecoration = "none";
    link.style.color = "inherit";

    const icon = document.createElement('div');
    icon.className = 'user-icon';
    
    if (user.avatar) {
      const img = document.createElement('img');
      img.src = user.avatar;
      img.alt = user.handle;
      icon.appendChild(img);
    } else {
      icon.textContent = user.handle ? user.handle[0].toUpperCase() : '?';
    }
    
    const info = document.createElement('div');
    info.className = 'user-info';
    
    const handle = document.createElement('div');
    handle.className = 'user-handle';
    handle.textContent = user.handle || user.did;
    
    const did = document.createElement('div');
    did.className = 'user-did';
    did.textContent = user.did;
    
    info.appendChild(handle);
    info.appendChild(did);
    
    link.appendChild(icon);
    link.appendChild(info);
    li.appendChild(link);
    list.appendChild(li);
  });
}
