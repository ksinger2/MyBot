/**
 * spotify-planner.js
 *
 * Trip playlist planner that analyzes Spotify listening habits across
 * Discord users and builds collaborative road-trip playlists.
 * Relies on spotify-auth.js for authenticated Spotify Web API calls.
 */

const spotifyAuth = require('./spotify-auth');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HIGH_ENERGY_GENRES = new Set([
  'edm', 'electronic', 'dance', 'house', 'techno', 'drum-and-bass',
  'dubstep', 'hardstyle', 'punk', 'punk rock', 'hard rock', 'metal',
  'hip-hop', 'rap', 'trap', 'reggaeton', 'pop punk', 'ska',
]);

const LOW_ENERGY_GENRES = new Set([
  'ambient', 'chill', 'lo-fi', 'lofi', 'classical', 'sleep', 'jazz',
  'acoustic', 'folk', 'singer-songwriter', 'bossa nova', 'new age',
]);

/**
 * Infer an overall energy level from a list of genre strings.
 * @param {string[]} genres
 * @returns {'low'|'medium'|'high'}
 */
function inferEnergyLevel(genres) {
  let highCount = 0;
  let lowCount = 0;

  for (const g of genres) {
    const lower = g.toLowerCase();
    if (HIGH_ENERGY_GENRES.has(lower)) highCount++;
    if (LOW_ENERGY_GENRES.has(lower)) lowCount++;
  }

  if (highCount > lowCount * 2) return 'high';
  if (lowCount > highCount * 2) return 'low';
  return 'medium';
}

/**
 * Tally genre occurrences and return sorted descending by count.
 * @param {string[]} allGenres - flat list (may contain duplicates)
 * @param {number} [limit=10]
 * @returns {string[]}
 */
function tallyGenres(allGenres, limit = 10) {
  const counts = {};
  for (const g of allGenres) {
    counts[g] = (counts[g] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([genre]) => genre);
}

/**
 * Find elements that appear in every provided array.
 * @param {Array<string[]>} arrays
 * @returns {string[]}
 */
function findOverlap(arrays) {
  if (arrays.length === 0) return [];
  if (arrays.length === 1) return [...new Set(arrays[0])];

  const first = new Set(arrays[0]);
  for (let i = 1; i < arrays.length; i++) {
    const current = new Set(arrays[i]);
    for (const item of first) {
      if (!current.has(item)) first.delete(item);
    }
  }
  return [...first];
}

/**
 * Shuffle an array in place (Fisher-Yates).
 * @param {any[]} arr
 * @returns {any[]}
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Analyze a single user's Spotify listening habits.
 *
 * Fetches top tracks (short_term + medium_term) and top artists, tallies
 * genres, and infers an energy level.
 *
 * @param {string} discordUserId
 * @returns {Promise<{topGenres: string[], topArtists: string[], topTracks: Array<{name: string, artist: string, uri: string}>, energyLevel: 'low'|'medium'|'high'}>}
 */
async function analyzeUserTastes(discordUserId) {
  // Fetch top tracks for both time ranges in parallel
  const [shortTracks, mediumTracks, topArtistsData] = await Promise.all([
    spotifyAuth.getTopTracks(discordUserId, { time_range: 'short_term', limit: 30 }),
    spotifyAuth.getTopTracks(discordUserId, { time_range: 'medium_term', limit: 30 }),
    spotifyAuth.getTopArtists(discordUserId, { time_range: 'medium_term', limit: 20 }),
  ]);

  // De-duplicate tracks by URI
  const trackMap = new Map();
  for (const t of [...shortTracks.items, ...mediumTracks.items]) {
    if (!trackMap.has(t.uri)) {
      trackMap.set(t.uri, {
        name: t.name,
        artist: t.artists.map((a) => a.name).join(', '),
        uri: t.uri,
      });
    }
  }
  const topTracks = [...trackMap.values()];

  // Extract artist names
  const topArtists = topArtistsData.items.map((a) => a.name);

  // Collect all genres from the artists response
  const allGenres = topArtistsData.items.flatMap((a) => a.genres || []);
  const topGenres = tallyGenres(allGenres);
  const energyLevel = inferEnergyLevel(allGenres);

  return { topGenres, topArtists, topTracks, energyLevel };
}

/**
 * Generate a collaborative road-trip playlist for multiple Discord users.
 *
 * @param {string[]} discordUserIds - Array of Discord user IDs
 * @param {object} tripInfo
 * @param {string} tripInfo.destination - Where the trip is going
 * @param {number} [tripInfo.driveDuration=120] - Drive time in minutes (default 2 hrs)
 * @param {string} [tripInfo.mood] - Optional mood descriptor (e.g. "chill", "hype")
 * @param {boolean} [tripInfo.stayAwake] - Bias toward high-energy if true
 * @returns {Promise<{playlistUrl: string, trackCount: number, skippedUsers: string[], sharedArtists: string[], sharedGenres: string[]}>}
 */
async function generateTripPlaylist(discordUserIds, tripInfo) {
  const driveDuration = tripInfo.driveDuration || 120; // minutes
  const avgSongMinutes = 3.5;
  const targetTrackCount = Math.round(driveDuration / avgSongMinutes);

  // Analyze each user's tastes (skip unconnected)
  const profiles = [];
  const skippedUsers = [];

  for (const userId of discordUserIds) {
    try {
      const profile = await analyzeUserTastes(userId);
      profiles.push({ userId, ...profile });
    } catch (err) {
      // User likely not connected to Spotify
      skippedUsers.push(userId);
    }
  }

  if (profiles.length === 0) {
    throw new Error('No connected Spotify users found — cannot create playlist.');
  }

  // Find overlapping artists and genres across connected users
  const sharedArtists = findOverlap(profiles.map((p) => p.topArtists));
  const sharedGenres = findOverlap(profiles.map((p) => p.topGenres));

  // Collect track URIs per bucket
  const sharedTrackUris = [];
  const perUserTrackUris = [];

  // Shared taste: tracks from artists both users like
  const sharedArtistSet = new Set(sharedArtists.map((a) => a.toLowerCase()));
  for (const profile of profiles) {
    for (const t of profile.topTracks) {
      const artistLower = t.artist.toLowerCase();
      if ([...sharedArtistSet].some((sa) => artistLower.includes(sa))) {
        sharedTrackUris.push(t.uri);
      }
    }
  }

  // Per-user tracks (not already shared)
  const sharedSet = new Set(sharedTrackUris);
  for (const profile of profiles) {
    const userTracks = profile.topTracks
      .filter((t) => !sharedSet.has(t.uri))
      .map((t) => t.uri);
    perUserTrackUris.push(userTracks);
  }

  // If stayAwake, bias toward high-energy by filtering out low-energy when possible
  if (tripInfo.stayAwake) {
    // We keep all tracks but will prioritize high-energy in ordering later
    // For now, just note the preference — real energy filtering would
    // require audio-features API calls per track, so we bias via genre search
  }

  // Calculate mix allocations
  const sharedSlots = Math.round(targetTrackCount * 0.4);
  const perUserSlots = Math.round(targetTrackCount * 0.3);

  // Build final URI list with the 40/30/30 mix
  const finalUris = [];

  // 40% shared taste
  shuffle(sharedTrackUris);
  finalUris.push(...sharedTrackUris.slice(0, sharedSlots));

  // 30% per user (split evenly among connected users)
  const slotsEach = Math.floor(perUserSlots / profiles.length) || 1;
  for (const userTracks of perUserTrackUris) {
    shuffle(userTracks);
    finalUris.push(...userTracks.slice(0, slotsEach));
  }

  // Search for destination-themed tracks (songs about the place)
  try {
    const destinationQuery = tripInfo.destination;
    const searchResults = await spotifyAuth.searchTracks(
      profiles[0].userId,
      destinationQuery,
      { limit: 10 }
    );
    if (searchResults && searchResults.tracks && searchResults.tracks.items) {
      const destinationUris = searchResults.tracks.items
        .filter((t) => !new Set(finalUris).has(t.uri))
        .map((t) => t.uri)
        .slice(0, 5);
      finalUris.push(...destinationUris);
    }
  } catch (_) {
    // Non-critical — skip destination tracks if search fails
  }

  // If stayAwake, try to supplement with high-energy search results
  if (tripInfo.stayAwake && sharedGenres.length > 0) {
    try {
      const energyGenre = [...HIGH_ENERGY_GENRES].find((g) =>
        sharedGenres.some((sg) => sg.toLowerCase().includes(g))
      ) || 'energy';
      const energyResults = await spotifyAuth.searchTracks(
        profiles[0].userId,
        `genre:${energyGenre}`,
        { limit: 10 }
      );
      if (energyResults && energyResults.tracks && energyResults.tracks.items) {
        const existingSet = new Set(finalUris);
        const energyUris = energyResults.tracks.items
          .filter((t) => !existingSet.has(t.uri))
          .map((t) => t.uri)
          .slice(0, 5);
        finalUris.push(...energyUris);
      }
    } catch (_) {
      // Non-critical
    }
  }

  // Trim or pad to target count
  const dedupedUris = [...new Set(finalUris)].slice(0, targetTrackCount);
  shuffle(dedupedUris);

  // Create the playlist
  const playlist = await createCollaborativePlaylist(
    discordUserIds,
    dedupedUris,
    tripInfo
  );

  return {
    playlistUrl: playlist.playlistUrl,
    trackCount: dedupedUris.length,
    skippedUsers,
    sharedArtists,
    sharedGenres,
  };
}

/**
 * Build a Claude prompt string listing users' top artists/genres and asking
 * for 30-50 song suggestions matching the trip vibe + destination.
 *
 * @param {Array<{userId: string, topArtists: string[], topGenres: string[], energyLevel: string}>} userProfiles
 * @param {object} tripInfo
 * @param {string} tripInfo.destination
 * @param {number} [tripInfo.driveDuration]
 * @param {string} [tripInfo.mood]
 * @param {boolean} [tripInfo.stayAwake]
 * @returns {string}
 */
function buildPlaylistPrompt(userProfiles, tripInfo) {
  const userSections = userProfiles
    .map((p, i) => {
      const artists = p.topArtists.slice(0, 10).join(', ');
      const genres = p.topGenres.slice(0, 8).join(', ');
      return `### User ${i + 1} (${p.userId})\n- **Top Artists:** ${artists}\n- **Top Genres:** ${genres}\n- **Energy Level:** ${p.energyLevel}`;
    })
    .join('\n\n');

  const moodClause = tripInfo.mood
    ? `The desired mood is: **${tripInfo.mood}**.`
    : 'No specific mood requested — choose a good road-trip mix.';

  const stayAwakeClause = tripInfo.stayAwake
    ? 'IMPORTANT: The driver needs to stay awake! Bias heavily toward upbeat, high-energy tracks. Avoid slow, ambient, or sleepy songs.'
    : '';

  const durationMinutes = tripInfo.driveDuration || 120;
  const approxSongs = Math.round(durationMinutes / 3.5);

  return `You are a music curator building a road-trip playlist. Suggest ${approxSongs} songs (between 30-50) that would work for a drive to **${tripInfo.destination}**.

## Listener Profiles
${userSections}

## Trip Details
- **Destination:** ${tripInfo.destination}
- **Drive Duration:** ~${durationMinutes} minutes
${moodClause}
${stayAwakeClause}

## Instructions
1. Find common ground between the listeners' tastes — prioritize artists/genres they share.
2. Include a few songs that reference or evoke the destination (songs about the place, region, or vibe).
3. Balance familiar favorites with discovery picks they'd likely enjoy.
4. Vary the energy — start medium, build up, then ease back before the end. ${tripInfo.stayAwake ? 'But keep overall energy HIGH.' : ''}
5. For each song, provide: **Song Title** — **Artist** (and Spotify URI if you know it).

Return the list as a numbered markdown list. After the list, add a one-sentence summary of the playlist vibe.`;
}

/**
 * Create a collaborative playlist on the first connected user's Spotify
 * account, add all provided tracks, and return the playlist URL.
 *
 * @param {string[]} discordUserIds - Discord user IDs (first connected user is the owner)
 * @param {string[]} trackUris - Array of Spotify track URIs (e.g. "spotify:track:xxx")
 * @param {object} tripInfo
 * @param {string} tripInfo.destination
 * @returns {Promise<{playlistUrl: string, playlistId: string}>}
 */
async function createCollaborativePlaylist(discordUserIds, trackUris, tripInfo) {
  // Find the first user who has a connected Spotify account
  let ownerId = null;
  for (const userId of discordUserIds) {
    try {
      const connected = await spotifyAuth.isConnected(userId);
      if (connected) {
        ownerId = userId;
        break;
      }
    } catch (_) {
      continue;
    }
  }

  if (!ownerId) {
    throw new Error('No connected Spotify user found to create the playlist.');
  }

  const playlistName = `Road Trip to ${tripInfo.destination} 🚗`;
  const description = `Collaborative road-trip playlist for ${discordUserIds.length} travelers. Generated by MyBot.`;

  // Create the playlist
  const playlist = await spotifyAuth.createPlaylist(ownerId, {
    name: playlistName,
    description,
    public: false,
    collaborative: true,
  });

  // Add tracks in batches of 100 (Spotify API limit)
  const BATCH_SIZE = 100;
  for (let i = 0; i < trackUris.length; i += BATCH_SIZE) {
    const batch = trackUris.slice(i, i + BATCH_SIZE);
    await spotifyAuth.addTracksToPlaylist(ownerId, playlist.id, batch);
  }

  return {
    playlistUrl: playlist.external_urls.spotify,
    playlistId: playlist.id,
  };
}

module.exports = {
  analyzeUserTastes,
  generateTripPlaylist,
  buildPlaylistPrompt,
  createCollaborativePlaylist,
};
