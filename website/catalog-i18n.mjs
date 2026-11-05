/**
 * RU→EN translation for legacy SMM catalog entries.
 *
 * Upstream catalogs ship Russian templated names like
 *   "Telegram / ᴛɢ | Подписчики | 🇷🇺 Россия | ♻ 30 | ❎"
 * The segments are highly repetitive, so a phrase dictionary + pattern
 * rules + word-level fallback + transliteration covers them deterministically.
 *
 * Anything still containing Cyrillic after all passes is transliterated —
 * the public catalog must be ASCII-readable.
 */

/* ---------- platform prefixes: "Telegram / ᴛɢ" → "Telegram" ---------- */

const PLATFORM_PREFIXES = new Map(Object.entries({
  "telegram": "Telegram",
  "instagram": "Instagram",
  "youtube": "YouTube",
  "tiktok": "TikTok",
  "twitch": "Twitch",
  "facebook": "Facebook",
  "kick": "Kick",
  "rutube": "Rutube",
  "вконтакте": "VK",
  "x (twitter)": "X (Twitter)",
  "twitter": "X (Twitter)",
  "shopee": "Shopee",
  "spotify": "Spotify",
  "linkedin": "LinkedIn",
  "audiomack": "Audiomack",
  "tripadvisor": "Tripadvisor",
  "soundcloud": "SoundCloud",
  "discord": "Discord",
  "vk видео live": "VK Video Live",
  "яндекс дзен": "Yandex Zen",
  "яндекс маркет": "Yandex Market",
  "яндекс": "Yandex",
  "chaturbate": "Chaturbate",
  "одноклассники": "Odnoklassniki",
  "whatsapp": "WhatsApp",
  "reddit": "Reddit",
  "авито": "Avito",
  "github": "GitHub",
  "behance": "Behance",
  "kwai": "Kwai",
  "pinterest": "Pinterest",
  "rumble": "Rumble",
  "wildberries": "Wildberries",
  "deezer": "Deezer",
  "google maps": "Google Maps",
  "ozon": "Ozon",
  "amazon": "Amazon",
  "threads": "Threads",
  "yappy": "Yappy",
  "likee": "Likee",
  "bizon365": "Bizon365",
  "boomplay": "Boomplay",
  "dlive": "DLive",
  "quora": "Quora",
  "apple podcast": "Apple Podcast",
  "max": "MAX",
  "для сайтов": "Website traffic",
  "крипта": "Crypto",
  "игры и дополнения": "Games & add-ons",
  "pornhub": "PornHub",
  "bongacams": "BongaCams",
}));

/** "Telegram / ᴛɢ" → "Telegram"; "Игры и дополнения / sᴛᴇᴀᴍ" → "Steam games" */
function translatePlatformPrefix(seg) {
  const m = seg.match(/^(.+?)\s*\/\s*([^\s/]+)$/u);
  if (!m) return null;
  const head = m[1].trim().toLowerCase();
  const sub = m[2].trim();
  const base = PLATFORM_PREFIXES.get(head) ?? (!/[а-яё]/i.test(head) ? m[1].trim() : null);
  if (!base) return null;
  if (/^sᴛᴇᴀᴍ$/i.test(sub)) return "Steam games";
  if (/^xʙᴏx$/i.test(sub)) return "Xbox games";
  if (/^ᴜʙɪsᴏғᴛ$/i.test(sub)) return "Ubisoft games";
  if (/^ᴇᴀ$/i.test(sub)) return "EA games";
  return base;
}

/* ---------- countries ---------- */

const COUNTRIES = {
  "россия": "Russia", "сша": "USA", "индия": "India", "турция": "Turkey",
  "китай": "China", "индонезия": "Indonesia", "германия": "Germany",
  "бразилия": "Brazil", "франция": "France", "италия": "Italy",
  "казахстан": "Kazakhstan", "узбекистан": "Uzbekistan",
  "великобритания": "UK", "израиль": "Israel", "испания": "Spain",
  "япония": "Japan", "украина": "Ukraine", "египет": "Egypt",
  "канада": "Canada", "нигерия": "Nigeria", "австралия": "Australia",
  "таиланд": "Thailand", "мексика": "Mexico", "саудовская аравия": "Saudi Arabia",
  "оаэ": "UAE", "тайвань": "Taiwan", "южная корея": "South Korea",
  "аргентина": "Argentina", "малайзия": "Malaysia", "бангладеш": "Bangladesh",
  "бельгия": "Belgium", "швейцария": "Switzerland", "греция": "Greece",
  "вьетнам": "Vietnam", "беларусь": "Belarus", "австрия": "Austria",
  "литва": "Lithuania", "венгрия": "Hungary", "финляндия": "Finland",
  "чили": "Chile", "дания": "Denmark", "эстония": "Estonia",
  "чехия": "Czechia", "хорватия": "Croatia", "мальта": "Malta",
  "латвия": "Latvia", "европа": "Europe", "иран": "Iran",
  "швеция": "Sweden", "португалия": "Portugal", "марокко": "Morocco",
  "пакистан": "Pakistan", "колумбия": "Colombia", "грузия": "Georgia",
  "албания": "Albania", "филиппины": "Philippines", "армения": "Armenia",
  "тунис": "Tunisia", "катар": "Qatar", "польша": "Poland",
  "алжир": "Algeria", "нидерланды": "Netherlands", "ирак": "Iraq",
  "ирландия": "Ireland", "доминикана": "Dominican Republic",
  "сербия": "Serbia", "болгария": "Bulgaria", "румыния": "Romania",
  "мир": "Worldwide", "снг": "CIS",
  "арабские страны": "Arab countries",
  "азербайджан": "Azerbaijan", "киргизия": "Kyrgyzstan",
  "таджикистан": "Tajikistan", "туркменистан": "Turkmenistan",
  "монголия": "Mongolia", "непал": "Nepal", "шри ланка": "Sri Lanka",
  "южная африка": "South Africa", "новая зеландия": "New Zealand",
  "северная македония": "North Macedonia", "коста рика": "Costa Rica",
  "пуэрто рико": "Puerto Rico", "сальвадор": "El Salvador",
};

/* ---------- full-segment phrases ---------- */

const PHRASES = new Map(Object.entries({
  "❎": "No refill",
  "✅": "Guaranteed",
  "🌍 любая страна": "Any country",
  "🌍 мир": "Worldwide",
  "🌏 мир": "Worldwide",
  "🇷🇺 россия и снг": "Russia & CIS",
  "для региона 🇷🇺 россия и снг": "Russia & CIS region",
  "для региона 🇷🇺 россия": "Russia region",
  "для региона 🌐 снг без россии": "CIS excl. Russia",
  "🇷🇺 россия + снг": "Russia + CIS",
  "🇺🇸 сша и 🇨🇦 канада": "USA & Canada",
  "подписчики": "FOLLOWERS_OR_MEMBERS",
  "просмотры": "Views",
  "просмотры видео": "Video views",
  "просмотры постов": "Post views",
  "просмотры на пост": "Post views",
  "просмотры историй": "Story views",
  "просмотры лесенкой": "Gradual views",
  "автопросмотры": "Auto views",
  "лайки": "Likes",
  "лайки на пост": "Post likes",
  "лайки на 1 пост": "Likes on 1 post",
  "лайки на видео": "Video likes",
  "автолайки": "Auto likes",
  "реакции": "Reactions",
  "реакции на пост": "Post reactions",
  "реакции на комментарий": "Comment reactions",
  "реакции на истории": "Story reactions",
  "автореакции": "Auto reactions",
  "авторепосты": "Auto reposts",
  "комментарии": "Comments",
  "живые нативные комментарии": "Live native comments",
  "репосты": "Reposts",
  "зрители": "Viewers",
  "зрители на стрим": "Live stream viewers",
  "зрители + чат боты": "Viewers + chat bots",
  "чат боты с сообщениями в чат": "Chat bots with messages",
  "с авторизацей в чате": "Chat-authorized",
  "с авторизацией в чате": "Chat-authorized",
  "без авторизации в чате": "No chat auth",
  "авторизованные": "Authorized",
  "неавторизованные": "Non-authorized",
  "с просмотрами": "With views",
  "без просмотров": "No views",
  "прослушивания": "Plays",
  "прослушивания трека": "Track plays",
  "прослушивания плейлиста / альбома": "Playlist / album plays",
  "прослушивания подкаста": "Podcast plays",
  "слушатели в месяц": "Monthly listeners",
  "слушатели в spaces": "Spaces listeners",
  "сохранения": "Saves",
  "сохранения трека / альбома": "Track / album saves",
  "жалобы": "Reports",
  "жалобы на аккаунт": "Account reports",
  "старты бота": "Bot starts",
  "старты бота с активностью": "Bot starts with activity",
  "ежедневные рестарты бота": "Daily bot restarts",
  "буст канала": "Channel boost",
  "бусты каналов": "Channel boosts",
  "на видео": "On video",
  "premium пользователи": "Premium users",
  "⭐️ premium аккаунты": "Premium accounts",
  "премиум аккаунты": "Premium accounts",
  "⭐️premium подписчиков": "Premium followers",
  "собственные": "Own",
  "с рекламы": "From ads",
  "для открытых каналов": "Public channels",
  "для приватных каналов": "Private channels",
  "для закрытых каналов": "Private channels",
  "открытые + приватные каналы": "Public + private channels",
  "женский пол": "Female",
  "мужской пол": "Male",
  "женщины": "Female",
  "мужчины": "Male",
  "быстрые": "Fast",
  "плавные": "Gradual",
  "рандомные": "Random",
  "🟢 онлайн": "Online",
  "👑 живые": "Real",
  "👑 идут в статистику": "Counted in stats",
  "собственный текст сообщений": "Custom message text",
  "только мобильный трафик": "Mobile traffic only",
  "друзья": "Friends",
  "голосования": "Poll votes",
  "добавить товар в корзину": "Add to cart",
  "добавление в корзину": "Add to cart",
  "насилие": "Violence report",
  "незаконные товары и услуги": "Illegal goods report",
  "удержание": "Retention",
  "реальные пользователи": "Real users",
  "база 1": "Base 1",
  "база 2": "Base 2",
  "база 3": "Base 3",
  "ᴀᴜᴛᴏ": "AUTO",
  "dlc": "DLC",
  "upvotes": "Upvotes",
  "5 звёзд + отзывы (собственные)": "5 stars + reviews (own)",
  "не многословные": "Brief",
  "комплексное продвижение": "Full promotion",
  "индекс цитирования": "Citation index",
  "наркотики и психоактивные вещества": "Drugs & substances report",
  "наркотики": "Drugs report",
  "֎ ии умные чат боты с общением в чате": "AI smart chat bots",
  "💯": "100%",
  "просмотр всех сторис": "All stories views",
  "просмотр сторис": "Story views",
  "игры steam": "Steam games",
  "игры xbox": "Xbox games",
  "игры ubisoft": "Ubisoft games",
  "игры ea": "EA games",
}));

/* word-level fallback */
const WORDS = {
  "подписчики": "FOLLOWERS_OR_MEMBERS",
  "подписчиков": "FOLLOWERS_OR_MEMBERS",
  "просмотры": "views", "просмотров": "views",
  "автопросмотры": "auto views", "автопросмотров": "auto views",
  "лайки": "likes", "лайков": "likes",
  "реакции": "reactions", "автореакции": "auto reactions",
  "комментарии": "comments", "комментариев": "comments",
  "репосты": "reposts", "авторепосты": "auto reposts",
  "зрители": "viewers", "зрителей": "viewers",
  "прослушивания": "plays", "прослушиваний": "plays",
  "слушатели": "listeners", "слушателей": "listeners",
  "сохранения": "saves", "жалобы": "reports",
  "подписки": "subscriptions", "отписки": "unsubscribes",
  "видео": "video", "пост": "post", "поста": "post", "постов": "posts",
  "посты": "posts", "истории": "stories", "историй": "stories",
  "сторис": "stories", "трека": "track", "трек": "track",
  "плейлиста": "playlist", "плейлист": "playlist", "альбома": "album",
  "альбом": "album", "подкаста": "podcast", "подкаст": "podcast",
  "каналов": "channels", "канала": "channel", "канал": "channel",
  "бота": "bot", "бот": "bot", "старты": "starts", "старт": "start",
  "рестарты": "restarts", "аккаунты": "accounts", "аккаунта": "account",
  "аккаунт": "account", "пользователи": "users", "пользователей": "users",
  "чат": "chat", "чате": "chat", "стрим": "stream", "стрима": "stream",
  "рекламы": "ads", "реклама": "ads",
  "новых": "new", "новые": "new", "новый": "new",
  "будущих": "future", "последние": "latest",
  "вечная": "lifetime", "гарантия": "guarantee", "гарантии": "guarantee",
  "месяц": "month", "месяца": "months", "неделя": "week", "недели": "weeks",
  "день": "day", "дня": "days", "дней": "days",
  "час": "hour", "часа": "hours", "часов": "hours",
  "минут": "minutes", "минуты": "minutes",
  "мужской": "male", "женский": "female", "пол": "gender",
  "мир": "worldwide", "страна": "country", "любая": "any",
  "региона": "region", "снг": "cis", "россия": "russia",
  "без": "without", "для": "for", "на": "on", "и": "&", "в": "in",
  "с": "with", "от": "from", "по": "per", "или": "or",
  "быстрые": "fast", "быстрый": "fast", "плавные": "gradual",
  "рандомные": "random", "собственные": "own", "собственный": "own",
  "живые": "real", "нативные": "native",
  "игры": "games", "дополнения": "add-ons",
  "бусты": "boosts", "буст": "boost",
  "отзывы": "reviews", "отзыв": "review",
  "друзья": "friends", "группы": "groups", "группа": "group",
  "сообщества": "communities", "сообщество": "community",
  "дошли": "delivered", "онлайн": "online",
  "голосования": "poll votes", "голоса": "votes",
  "вопросы": "questions", "ответы": "answers",
  "добавить": "add", "товар": "product", "корзину": "cart",
  "избранное": "favorites", "желаний": "wishlist",
  "показы": "impressions", "охват": "reach",
  "просмотр": "views", "всех": "all", "все": "all", "всех сторис": "stories",
  "переходы": "clicks", "клики": "clicks",
  "установки": "installs", "установок": "installs",
  "приложения": "apps", "приложений": "apps", "приложение": "app",
  "участники": "participants", "мероприятия": "events", "мероприятие": "event",
  "комментарий": "comment", "сообществе": "community",
  "рекламного": "ad", "рекламное": "ad", "сообщения": "message",
  "поиске": "search", "поиск": "search",
  "артиста": "artist", "артист": "artist", "пользователя": "user",
  "наркотики": "drugs", "психоактивные": "psychoactive",
  "вещества": "substances", "веществ": "substances",
  "индекс": "index", "цитирования": "citation",
  "запрещённых": "restricted", "запрещенных": "restricted",
  "сайтах": "sites", "сайт": "site", "сайта": "site",
  "регистрации": "registration", "регистрация": "registration",
  "монетизацией": "monetization", "монетизация": "monetization",
  "года": "year", "год": "year",
  "закрытых": "private", "закрытые": "private", "каналах": "channels",
  "жестокость": "cruelty", "крайняя": "extreme", "расчленение": "dismemberment",
  "другие": "other", "другой": "other",
  "удержание": "retention", "реальные": "real", "реальный": "real",
  "сек": "sec", "секунд": "sec", "секунды": "sec",
  "автопросмотрами": "auto views",
  "порнографические": "pornographic", "материалы": "materials",
  "интимные": "intimate", "изображения": "images", "согласия": "consent",
  "персональные": "personal", "личные": "personal", "данные": "data",
  "поднятие": "boost", "топ": "top",
};

/* ---------- transliteration ---------- */

const TRANSLIT = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
  "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
  "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
  "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
  "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
};

function transliterate(text) {
  return [...text].map((ch) => {
    const low = ch.toLowerCase();
    if (!(low in TRANSLIT)) return ch;
    const t = TRANSLIT[low];
    return ch === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
  }).join("");
}

/* ---------- segment translation ---------- */

const RU_DURATION = /^(\d+)\s*(минут[аы]?|час(?:а|ов)?|дн(?:я|ей)?|недел(?:я|и|ю)|месяц(?:а|ев)?)/i;
const EN_UNIT = {
  "минут": "min", "минута": "min", "минуты": "min",
  "час": "h", "часа": "h", "часов": "h",
  "день": "d", "дня": "d", "дней": "d",
  "неделя": "w", "недели": "w", "неделю": "w",
  "месяц": "mo", "месяца": "mo", "месяцев": "mo",
};

function resolveWord(word, platform) {
  const t = WORDS[word.toLowerCase()];
  if (!t) return null;
  if (t === "FOLLOWERS_OR_MEMBERS") return platform === "telegram" ? "members" : "followers";
  return t;
}

export function translateSegment(seg, platform) {
  const t = seg.trim();
  if (!t) return t;

  const prefix = translatePlatformPrefix(t);
  if (prefix) return prefix;

  // guarantee: "♻ 30", "♻️ ∞ Вечная гарантия", "👑 ♻ ∞ Вечная гарантия"
  if (t.includes("♻")) {
    const num = t.match(/(\d+)/);
    if (num) return `Refill ${num[1]}d`;
    if (/∞|вечн/i.test(t)) return "Lifetime refill";
    return "Refill";
  }
  if (t === "❎") return "No refill";
  if (t === "✅") return "Guaranteed";
  // decorative emoji prefixes carry meaning only for a few known cases
  if (t === "👑") return "Real";

  if (!/[а-яё]/i.test(t)) return t;

  const low = t.toLowerCase();

  const phrase = PHRASES.get(low);
  if (phrase === "FOLLOWERS_OR_MEMBERS") return platform === "telegram" ? "Members" : "Followers";
  if (phrase) return phrase;

  // durations: "1 час", "30 минут", "на 30 дней", "на 7 дней"
  const dur = t.match(RU_DURATION);
  if (dur) {
    const unit = EN_UNIT[dur[2].toLowerCase()] ?? dur[2];
    const span = `${dur[1]}${unit}`;
    return /^на\s/i.test(t) ? `For ${span}` : span;
  }

  // geo: flag + country, "Для региона X"
  const geoMatch = t.match(/[а-яё]+(?:\s[а-яё]+)?/i);
  if (geoMatch) {
    const geoPhrase = COUNTRIES[geoMatch[0].toLowerCase()];
    if (geoPhrase && /^\D{0,4}\s*[а-яё]/i.test(t) && t.length < 40) {
      return /^для региона/i.test(t) ? `${geoPhrase} region` : geoPhrase;
    }
  }

  // trailing spans: "на 90 дней", "на 50 будущих постов"
  let working = t
    .replace(/на\s+(\d+)\s+(?:будущих\s+|последние\s+)?постов?/gi, "for $1 posts")
    .replace(/на\s+(\d+)\s+(?:дней|дня|день)/gi, "for $1d");

  // word-level fallback
  const words = working.split(/(\s+|\/|[(,)])/).map((tok) => {
    if (!/[а-яё]/i.test(tok)) return tok;
    const stripped = tok.toLowerCase().replace(/[.,;:]+$/, "");
    return resolveWord(stripped, platform) ?? transliterate(tok);
  }).join("");
  const joined = words.replace(/\s+/g, " ").replace(/\s+([.,;:)])/g, "$1").replace(/([(])\s+/g, "$1").trim();
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function translateName(name, platform) {
  return String(name)
    .split("|")
    .map((seg) => translateSegment(seg, platform))
    .filter(Boolean)
    .join(" | ")
    .replace(/\s+/g, " ")
    .trim();
}

export function translateCategory(category, platform) {
  return String(category)
    .split(" / ")
    .map((seg) => {
      const prefix = translatePlatformPrefix(seg.trim());
      if (prefix) return prefix;
      return translateSegment(seg, platform);
    })
    .join(" / ");
}
