const fs = require('fs');
const https = require('https');
const path = require('path');

// Target SVG Path
const SVG_PATH = path.join(__dirname, 'status.svg');

// Helper to make HTTPS requests
function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });
    
    req.on('error', (err) => reject(err));
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Convert ISO Date to relative "time ago"
function timeAgo(dateString) {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.round(diffMs / 60000);
    const diffHrs = Math.round(diffMin / 60);
    const diffDays = Math.round(diffHrs / 24);

    if (diffMin < 2) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHrs < 24) return `${diffHrs}h ago`;
    if (diffDays === 1) return 'yesterday';
    return `${diffDays} days ago`;
  } catch (e) {
    return 'recently';
  }
}

// Truncate long strings for SVG display
function truncate(str, maxLength = 35) {
  if (!str) return '';
  // Escape HTML/XML entities
  const escaped = str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  if (escaped.length > maxLength) {
    return escaped.substring(0, maxLength - 3) + '...';
  }
  return escaped;
}

// Main runner function
async function run() {
  console.log('Starting widget generation...');
  
  let commits = 1240; // Default fallback stats
  let stars = 42;
  let topRepo = 'Raptor';
  let latestCommit = {
    message: 'Optimized VM register allocation in unsafe JIT loop',
    repo: 'Raptor',
    date: new Date().toISOString()
  };
  
  const githubToken = process.env.GITHUB_TOKEN;
  
  if (githubToken) {
    console.log('GitHub Token found. Querying GitHub API...');
    try {
      const query = JSON.stringify({
        query: `
          query {
            user(login: "InfiniteFightingGhost") {
              contributionsCollection {
                totalCommitContributions
              }
              repositories(first: 100, ownerAffiliations: OWNER, orderBy: {field: PUSHED_AT, direction: DESC}) {
                totalCount
                nodes {
                  name
                  stargazerCount
                  defaultBranchRef {
                    target {
                      ... on Commit {
                        message
                        committedDate
                      }
                    }
                  }
                }
              }
            }
          }
        `
      });
      
      const response = await makeRequest({
        hostname: 'api.github.com',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'User-Agent': 'InfiniteFightingGhost-Status-Widget',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(query)
        }
      }, query);
      
      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        if (result.data && result.data.user) {
          const user = result.data.user;
          commits = user.contributionsCollection.totalCommitContributions || commits;
          
          const repos = user.repositories.nodes || [];
          stars = repos.reduce((acc, repo) => acc + (repo.stargazerCount || 0), 0);
          
          // Find top starred repo
          const top = repos.reduce((max, repo) => (repo.stargazerCount || 0) > (max.stargazerCount || 0) ? repo : max, repos[0] || { name: 'Raptor', stargazerCount: 0 });
          topRepo = top.name;
          
          // Get latest pushed repo default branch commit
          const activeRepo = repos[0];
          if (activeRepo && activeRepo.defaultBranchRef && activeRepo.defaultBranchRef.target) {
            latestCommit = {
              message: activeRepo.defaultBranchRef.target.message,
              repo: activeRepo.name,
              date: activeRepo.defaultBranchRef.target.committedDate
            };
          }
          console.log('GitHub stats loaded successfully!');
        } else {
          console.warn('Invalid GraphQL response, using fallbacks:', result.errors);
        }
      } else {
        console.warn(`GitHub API returned status ${response.statusCode}, using fallbacks: ${response.body}`);
      }
    } catch (err) {
      console.error('Error fetching GitHub stats, using fallbacks:', err);
    }
  } else {
    console.log('No GITHUB_TOKEN environment variable found. Using simulated GitHub data.');
  }

  // Spotify integration
  let spotifyData = null;
  const spotifyClientId = process.env.SPOTIFY_CLIENT_ID;
  const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const spotifyRefreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
  
  if (spotifyClientId && spotifyClientSecret && spotifyRefreshToken) {
    console.log('Spotify credentials found. Querying Spotify API...');
    try {
      // 1. Get Access Token using refresh token
      const authHeader = Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString('base64');
      const postData = `grant_type=refresh_token&refresh_token=${spotifyRefreshToken}`;
      
      const tokenResponse = await makeRequest({
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, postData);
      
      if (tokenResponse.statusCode === 200) {
        const tokenResult = JSON.parse(tokenResponse.body);
        const accessToken = tokenResult.access_token;
        
        // 2. Get Currently Playing song
        const playerResponse = await makeRequest({
          hostname: 'api.spotify.com',
          path: '/v1/me/player/currently-playing',
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
        
        if (playerResponse.statusCode === 200 && playerResponse.body) {
          const playerData = JSON.parse(playerResponse.body);
          if (playerData.is_playing && playerData.item) {
            spotifyData = {
              title: playerData.item.name,
              artist: playerData.item.artists.map(a => a.name).join(', ')
            };
            console.log(`Currently playing on Spotify: ${spotifyData.title} by ${spotifyData.artist}`);
          }
        } else {
          console.log('Spotify is not currently playing music (Status 204 or empty response).');
        }
      } else {
        console.warn(`Spotify auth failed with status ${tokenResponse.statusCode}: ${tokenResponse.body}`);
      }
    } catch (err) {
      console.error('Error fetching Spotify state:', err);
    }
  } else {
    console.log('Spotify credentials not fully configured. Using coding activity status.');
  }

  // Choose display content for the status column
  let statusLabel = 'LAST FOLD (ACTIVITY)';
  let statusTitle = `${latestCommit.repo}: "${latestCommit.message}"`;
  let statusSub = `${timeAgo(latestCommit.date)} • Compiled successfully`;
  let dynamicGraphics = '';
  
  if (spotifyData) {
    statusLabel = 'LISTENING TO (SPOTIFY)';
    statusTitle = spotifyData.title;
    statusSub = `by ${spotifyData.artist}`;
    
    // Equalizer animation
    dynamicGraphics = `
      <g class="eq-bars" transform="translate(760, 45)" fill="#10b981" filter="url(#mintGlow)">
        <rect x="0" y="0" width="3" height="30" rx="1.5">
          <animate attributeName="height" values="8;30;12;25;8" dur="1.2s" repeatCount="indefinite" />
          <animate attributeName="y" values="22;0;18;5;22" dur="1.2s" repeatCount="indefinite" />
        </rect>
        <rect x="7" y="0" width="3" height="30" rx="1.5">
          <animate attributeName="height" values="18;8;28;15;18" dur="0.9s" repeatCount="indefinite" />
          <animate attributeName="y" values="12;22;2;15;12" dur="0.9s" repeatCount="indefinite" />
        </rect>
        <rect x="14" y="0" width="3" height="30" rx="1.5">
          <animate attributeName="height" values="28;14;8;22;28" dur="1.5s" repeatCount="indefinite" />
          <animate attributeName="y" values="2;16;22;8;2" dur="1.5s" repeatCount="indefinite" />
        </rect>
        <rect x="21" y="0" width="3" height="30" rx="1.5">
          <animate attributeName="height" values="10;24;15;8;10" dur="1.1s" repeatCount="indefinite" />
          <animate attributeName="y" values="20;6;15;22;20" dur="1.1s" repeatCount="indefinite" />
        </rect>
      </g>
    `;
  } else {
    // Coding pulse animation
    dynamicGraphics = `
      <g class="coding-pulse" transform="translate(760, 45)">
        <circle cx="15" cy="15" r="10" fill="#10b981" fill-opacity="0.1" filter="url(#mintGlow)">
          <animate attributeName="r" values="8;18;8" dur="2s" repeatCount="indefinite" />
          <animate attributeName="fill-opacity" values="0.2;0.02;0.2" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle cx="15" cy="15" r="5" fill="#10b981" filter="url(#mintGlow)" />
      </g>
    `;
  }

  // Construct final SVG
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850 120" width="100%" height="100%">
  <defs>
    <!-- Background Gradient -->
    <linearGradient id="widgetGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0d14" />
      <stop offset="100%" stop-color="#111622" />
    </linearGradient>

    <!-- Neon Glow Filter -->
    <filter id="mintGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>

  <style>
    .panel { fill: url(#widgetGrad); stroke: #10b981; stroke-width: 1; stroke-opacity: 0.15; }
    .label { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 10px; font-weight: 700; fill: #10b981; opacity: 0.45; letter-spacing: 1.5px; }
    .title-val { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 16px; font-weight: 700; fill: #e6fffa; }
    .sub-val { font-family: 'Fira Code', 'Courier New', monospace; font-size: 11px; fill: #a7f3d0; opacity: 0.8; }
    
    .stats-label { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 11px; fill: #a7f3d0; opacity: 0.6; }
    .stats-num { font-family: 'Fira Code', 'Courier New', monospace; font-size: 12px; font-weight: bold; fill: #e6fffa; }
    
    .divider { stroke: #10b981; stroke-width: 1; stroke-opacity: 0.08; stroke-dasharray: 4,4; }
  </style>

  <!-- Panel Border and Background -->
  <rect x="1" y="1" width="848" height="118" rx="8" class="panel" />

  <!-- Column 1: System Stats -->
  <g transform="translate(25, 20)">
    <text x="0" y="15" class="label">SYSTEM METRICS (YEAR)</text>
    
    <!-- Commits -->
    <text x="0" y="42" class="stats-label">Contributions:</text>
    <text x="120" y="42" class="stats-num">${commits}</text>
    
    <!-- Stars -->
    <text x="0" y="67" class="stats-label">Stars Garnered:</text>
    <text x="120" y="67" class="stats-num">${stars}</text>
    
    <!-- Top Repo -->
    <text x="0" y="92" class="stats-label">Top Formation:</text>
    <text x="120" y="92" class="stats-num">${truncate(topRepo, 20)}</text>
  </g>

  <!-- Divider -->
  <line x1="330" y1="15" x2="330" y2="105" class="divider" />

  <!-- Column 2: Live Activity -->
  <g transform="translate(360, 20)">
    <text x="0" y="15" class="label">${statusLabel}</text>
    <text x="0" y="45" class="title-val">${truncate(statusTitle, 48)}</text>
    <text x="0" y="70" class="sub-val">${truncate(statusSub, 55)}</text>
  </g>

  <!-- Dynamic graphics section -->
  ${dynamicGraphics}

</svg>`;

  fs.writeFileSync(SVG_PATH, svg);
  console.log(`Successfully generated status.svg at: ${SVG_PATH}`);
}

run().catch(err => {
  console.error('Fatal error running generator:', err);
  process.exit(1);
});
