/**
 * Parity of the AEO text primitives with Python — tests on GOLDEN pairs.
 *
 * Every expectation in the GOLD_* blocks was captured by running the actual
 * function bodies from core/aeo.py on CPython 3.12 (verbatim copies of
 * `_norm_prompt`, `_variant_re`, `_variant_hit`, `_cyr_words`, `_content_words`,
 * `re.findall(r"\w{3,}")`, `_looks_like_chat`, `_looks_human`, `round`) — not
 * made up by hand. If a test here goes red, the PORT has diverged, not "the
 * fixture is stale": check against Python first, then fix text.ts.
 *
 * Separately, below the golden pairs — "trap" cases with explicit names: they
 * deliberately duplicate part of the fixtures so jest's output shows EXACTLY
 * the mistake a naive port makes silently (ASCII-only \w and \b, Math.round
 * instead of banker's rounding, word boundaries around Cyrillic).
 */
import {
  contentTokens,
  contentWords,
  cyrWords,
  looksHuman,
  looksLikeChat,
  normPrompt,
  pyIndex,
  pyRound,
  variantHit,
  variantRe,
  type CyrWord,
  type PyText,
} from './text';

type GoldText = string | null;

const GOLD_NORM_PROMPT: ReadonlyArray<[input: GoldText, output: string]> = [
  ["", ""],
  [" ", ""],
  ["   \t\n  ", ""],
  [null, ""],
  ["Нетология, отзывы 2026!", "нетология отзывы 2026"],
  ["нетология", "нетология"],
  ["Нетология", "нетология"],
  ["ЧТО ЛУЧШЕ: Skillbox ИЛИ Нетология?", "что лучше skillbox или нетология"],
  ["мониторинг бренда crm", "мониторинг бренда crm"],
  ["Мониторинг бренда: CRM-система для B2B!", "мониторинг бренда crm система для b2b"],
  ["notion.so", "notion so"],
  ["t.me/ideata", "t me ideata"],
  ["vc.ru — что это?", "vc ru что это"],
  ["— озон,", "озон"],
  ["розонный магазин", "розонный магазин"],
  ["Ozon vs Wildberries — что дешевле в 2026?", "ozon vs wildberries что дешевле в 2026"],
  ["посоветуй CRM для отдела продаж B2B", "посоветуй crm для отдела продаж b2b"],
  ["cs go crash sites", "cs go crash sites"],
  ["top csgo skin sites 2026", "top csgo skin sites 2026"],
  ["Как заработать? Какие варианты есть?", "как заработать какие варианты есть"],
  ["Работает ли оплата картой в Тинькофф", "работает ли оплата картой в тинькофф"],
  ["бартер или деньги что выгоднее", "бартер или деньги что выгоднее"],
  ["Проанализируй предложения по кредитным картам для путешественников", "проанализируй предложения по кредитным картам для путешественников"],
  ["Изучи варианты обслуживания юрлиц", "изучи варианты обслуживания юрлиц"],
  ["is skin gambling legal", "is skin gambling legal"],
  ["any good alternatives to notion", "any good alternatives to notion"],
  ["I'm looking for a CRM", "i m looking for a crm"],
  ["Best CRM for small business 2026", "best crm for small business 2026"],
  ["Скидка 50% — это выгодно?!", "скидка 50 это выгодно"],
  ["цена   сервиса", "цена сервиса"],
  ["отзывы сервиса", "отзывы сервиса"],
  ["сайты с краш-игрой на скины cs go", "сайты с краш игрой на скины cs go"],
  ["где играть в краш на скины из cs go", "где играть в краш на скины из cs go"],
  ["which crash site should I use", "which crash site should i use"],
  ["which crash sites are trustworthy", "which crash sites are trustworthy"],
  ["Hello. World is nice", "hello world is nice"],
  ["Hello! World", "hello world"],
  ["Hello.World", "hello world"],
  ["Hello .World", "hello world"],
  ["a. b", "a b"],
  ["почему?", "почему"],
  ["??", ""],
  ["!!!", ""],
  ["...", ""],
  ["2026", "2026"],
  ["тест неразрывный пробел", "тест неразрывный пробел"],
  ["смесь Latin и Кириллицы 123 _under_score_", "смесь latin и кириллицы 123 _under_score_"],
  ["ёжик Ёлка ЙОД", "ёжик ёлка йод"],
  ["Skillbox — Нетология — Яндекс Практикум", "skillbox нетология яндекс практикум"],
  ["AI-поиск: GEO/AEO мониторинг (2026)", "ai поиск geo aeo мониторинг 2026"],
  ["  ведущие  пробелы  и  хвост  ", "ведущие пробелы и хвост"],
  ["one two", "one two"],
  ["one two three", "one two three"],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen"],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"],
  ["лучшие сайты с кейсами 2026", "лучшие сайты с кейсами 2026"],
  ["купить виртуальную АТС", "купить виртуальную атс"],
  ["посоветуй АТС для отдела продаж", "посоветуй атс для отдела продаж"],
  ["Что такое AEO", "что такое aeo"],
  ["Сравни Profound и Peec AI", "сравни profound и peec ai"],
  ["the quick brown fox", "the quick brown fox"],
  ["TELL me about it", "tell me about it"],
  ["Данные: 12.5% и 3,14 — округление", "данные 12 5 и 3 14 округление"],
  ["email me@example.com сейчас", "email me example com сейчас"],
  ["https://ideata.io/blog?utm=1", "https ideata io blog utm 1"],
  ["😀 эмодзи и текст", "эмодзи и текст"],
  ["Ⅻ римские Ⅻ", "ⅻ римские ⅻ"],
  ["①②③ круглые цифры", "①②③ круглые цифры"],
];

const GOLD_CONTENT_WORDS: ReadonlyArray<[input: GoldText, output: string[]]> = [
  ["", []],
  [" ", []],
  ["   \t\n  ", []],
  [null, []],
  ["Нетология, отзывы 2026!", ["2026","нето","отзы"]],
  ["нетология", ["нето"]],
  ["Нетология", ["нето"]],
  ["ЧТО ЛУЧШЕ: Skillbox ИЛИ Нетология?", ["skil","нето"]],
  ["мониторинг бренда crm", ["crm","брен","мони"]],
  ["Мониторинг бренда: CRM-система для B2B!", ["b2b","crm","брен","мони","сист"]],
  ["notion.so", ["noti"]],
  ["t.me/ideata", ["idea"]],
  ["vc.ru — что это?", []],
  ["— озон,", ["озон"]],
  ["розонный магазин", ["мага","розо"]],
  ["Ozon vs Wildberries — что дешевле в 2026?", ["2026","ozon","wild","деше"]],
  ["посоветуй CRM для отдела продаж B2B", ["b2b","crm","отде","посо","прод"]],
  ["cs go crash sites", ["cras","site"]],
  ["top csgo skin sites 2026", ["2026","csgo","site","skin","top"]],
  ["Как заработать? Какие варианты есть?", ["вари","зара"]],
  ["Работает ли оплата картой в Тинькофф", ["карт","опла","рабо","тинь"]],
  ["бартер или деньги что выгоднее", ["барт","выго","день"]],
  ["Проанализируй предложения по кредитным картам для путешественников", ["карт","кред","пред","проа","путе"]],
  ["Изучи варианты обслуживания юрлиц", ["вари","изуч","обсл","юрли"]],
  ["is skin gambling legal", ["gamb","lega","skin"]],
  ["any good alternatives to notion", ["alte","noti"]],
  ["I'm looking for a CRM", ["crm","look"]],
  ["Best CRM for small business 2026", ["2026","busi","crm","smal"]],
  ["Скидка 50% — это выгодно?!", ["выго","скид"]],
  ["цена   сервиса", ["серв","цена"]],
  ["отзывы сервиса", ["отзы","серв"]],
  ["сайты с краш-игрой на скины cs go", ["игро","краш","сайт","скин"]],
  ["где играть в краш на скины из cs go", ["игра","краш","скин"]],
  ["which crash site should I use", ["cras","shou","site","use"]],
  ["which crash sites are trustworthy", ["cras","site","trus"]],
  ["Hello. World is nice", ["hell","nice","worl"]],
  ["Hello! World", ["hell","worl"]],
  ["Hello.World", ["hell","worl"]],
  ["Hello .World", ["hell","worl"]],
  ["a. b", []],
  ["почему?", ["поче"]],
  ["??", []],
  ["!!!", []],
  ["...", []],
  ["2026", ["2026"]],
  ["тест неразрывный пробел", ["нера","проб","тест"]],
  ["смесь Latin и Кириллицы 123 _under_score_", ["123","_und","lati","кири","смес"]],
  ["ёжик Ёлка ЙОД", ["йод","ёжик","ёлка"]],
  ["Skillbox — Нетология — Яндекс Практикум", ["skil","нето","прак","янде"]],
  ["AI-поиск: GEO/AEO мониторинг (2026)", ["2026","aeo","geo","мони","поис"]],
  ["  ведущие  пробелы  и  хвост  ", ["веду","проб","хвос"]],
  ["one two", ["one","two"]],
  ["one two three", ["one","thre","two"]],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen", ["eigh","elev","five","four","nine","one","seve","six","ten","thir","thre","twel","two"]],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", ["eigh","elev","fift","five","four","nine","one","seve","six","ten","thir","thre","twel","two"]],
  ["лучшие сайты с кейсами 2026", ["2026","кейс","лучш","сайт"]],
  ["купить виртуальную АТС", ["атс","вирт","купи"]],
  ["посоветуй АТС для отдела продаж", ["атс","отде","посо","прод"]],
  ["Что такое AEO", ["aeo","тако"]],
  ["Сравни Profound и Peec AI", ["peec","prof","срав"]],
  ["the quick brown fox", ["brow","fox","quic"]],
  ["TELL me about it", ["abou","tell"]],
  ["Данные: 12.5% и 3,14 — округление", ["данн","окру"]],
  ["email me@example.com сейчас", ["com","emai","exam","сейч"]],
  ["https://ideata.io/blog?utm=1", ["blog","http","idea","utm"]],
  ["😀 эмодзи и текст", ["текс","эмод"]],
  ["Ⅻ римские Ⅻ", ["римс"]],
  ["①②③ круглые цифры", ["круг","цифр","①②③"]],
];

const GOLD_CONTENT_TOKENS: ReadonlyArray<[input: GoldText, output: string[]]> = [
  ["", []],
  [" ", []],
  ["   \t\n  ", []],
  [null, []],
  ["Нетология, отзывы 2026!", ["нетология","отзывы","2026"]],
  ["нетология", ["нетология"]],
  ["Нетология", ["нетология"]],
  ["ЧТО ЛУЧШЕ: Skillbox ИЛИ Нетология?", ["что","лучше","skillbox","или","нетология"]],
  ["мониторинг бренда crm", ["мониторинг","бренда","crm"]],
  ["Мониторинг бренда: CRM-система для B2B!", ["мониторинг","бренда","crm","система","для","b2b"]],
  ["notion.so", ["notion"]],
  ["t.me/ideata", ["ideata"]],
  ["vc.ru — что это?", ["что","это"]],
  ["— озон,", ["озон"]],
  ["розонный магазин", ["розонный","магазин"]],
  ["Ozon vs Wildberries — что дешевле в 2026?", ["ozon","wildberries","что","дешевле","2026"]],
  ["посоветуй CRM для отдела продаж B2B", ["посоветуй","crm","для","отдела","продаж","b2b"]],
  ["cs go crash sites", ["crash","sites"]],
  ["top csgo skin sites 2026", ["top","csgo","skin","sites","2026"]],
  ["Как заработать? Какие варианты есть?", ["как","заработать","какие","варианты","есть"]],
  ["Работает ли оплата картой в Тинькофф", ["работает","оплата","картой","тинькофф"]],
  ["бартер или деньги что выгоднее", ["бартер","или","деньги","что","выгоднее"]],
  ["Проанализируй предложения по кредитным картам для путешественников", ["проанализируй","предложения","кредитным","картам","для","путешественников"]],
  ["Изучи варианты обслуживания юрлиц", ["изучи","варианты","обслуживания","юрлиц"]],
  ["is skin gambling legal", ["skin","gambling","legal"]],
  ["any good alternatives to notion", ["any","good","alternatives","notion"]],
  ["I'm looking for a CRM", ["looking","for","crm"]],
  ["Best CRM for small business 2026", ["best","crm","for","small","business","2026"]],
  ["Скидка 50% — это выгодно?!", ["скидка","это","выгодно"]],
  ["цена   сервиса", ["цена","сервиса"]],
  ["отзывы сервиса", ["отзывы","сервиса"]],
  ["сайты с краш-игрой на скины cs go", ["сайты","краш","игрой","скины"]],
  ["где играть в краш на скины из cs go", ["где","играть","краш","скины"]],
  ["which crash site should I use", ["which","crash","site","should","use"]],
  ["which crash sites are trustworthy", ["which","crash","sites","are","trustworthy"]],
  ["Hello. World is nice", ["hello","world","nice"]],
  ["Hello! World", ["hello","world"]],
  ["Hello.World", ["hello","world"]],
  ["Hello .World", ["hello","world"]],
  ["a. b", []],
  ["почему?", ["почему"]],
  ["??", []],
  ["!!!", []],
  ["...", []],
  ["2026", ["2026"]],
  ["тест неразрывный пробел", ["тест","неразрывный","пробел"]],
  ["смесь Latin и Кириллицы 123 _under_score_", ["смесь","latin","кириллицы","123","_under_score_"]],
  ["ёжик Ёлка ЙОД", ["ёжик","ёлка","йод"]],
  ["Skillbox — Нетология — Яндекс Практикум", ["skillbox","нетология","яндекс","практикум"]],
  ["AI-поиск: GEO/AEO мониторинг (2026)", ["поиск","geo","aeo","мониторинг","2026"]],
  ["  ведущие  пробелы  и  хвост  ", ["ведущие","пробелы","хвост"]],
  ["one two", ["one","two"]],
  ["one two three", ["one","two","three"]],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen", ["one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen"]],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", ["one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen"]],
  ["лучшие сайты с кейсами 2026", ["лучшие","сайты","кейсами","2026"]],
  ["купить виртуальную АТС", ["купить","виртуальную","атс"]],
  ["посоветуй АТС для отдела продаж", ["посоветуй","атс","для","отдела","продаж"]],
  ["Что такое AEO", ["что","такое","aeo"]],
  ["Сравни Profound и Peec AI", ["сравни","profound","peec"]],
  ["the quick brown fox", ["the","quick","brown","fox"]],
  ["TELL me about it", ["tell","about"]],
  ["Данные: 12.5% и 3,14 — округление", ["данные","округление"]],
  ["email me@example.com сейчас", ["email","example","com","сейчас"]],
  ["https://ideata.io/blog?utm=1", ["https","ideata","blog","utm"]],
  ["😀 эмодзи и текст", ["эмодзи","текст"]],
  ["Ⅻ римские Ⅻ", ["римские"]],
  ["①②③ круглые цифры", ["①②③","круглые","цифры"]],
];

const GOLD_LOOKS_LIKE_CHAT: ReadonlyArray<[input: string, output: boolean]> = [
  ["", false],
  [" ", false],
  ["   \t\n  ", false],
  ["Нетология, отзывы 2026!", true],
  ["нетология", false],
  ["Нетология", false],
  ["ЧТО ЛУЧШЕ: Skillbox ИЛИ Нетология?", true],
  ["мониторинг бренда crm", false],
  ["Мониторинг бренда: CRM-система для B2B!", false],
  ["notion.so", false],
  ["t.me/ideata", false],
  ["vc.ru — что это?", true],
  ["— озон,", false],
  ["розонный магазин", false],
  ["Ozon vs Wildberries — что дешевле в 2026?", true],
  ["посоветуй CRM для отдела продаж B2B", true],
  ["cs go crash sites", false],
  ["top csgo skin sites 2026", true],
  ["Как заработать? Какие варианты есть?", true],
  ["Работает ли оплата картой в Тинькофф", true],
  ["бартер или деньги что выгоднее", true],
  ["Проанализируй предложения по кредитным картам для путешественников", true],
  ["Изучи варианты обслуживания юрлиц", true],
  ["is skin gambling legal", true],
  ["any good alternatives to notion", true],
  ["I'm looking for a CRM", true],
  ["Best CRM for small business 2026", true],
  ["Скидка 50% — это выгодно?!", true],
  ["цена   сервиса", false],
  ["отзывы сервиса", true],
  ["сайты с краш-игрой на скины cs go", false],
  ["где играть в краш на скины из cs go", true],
  ["which crash site should I use", true],
  ["which crash sites are trustworthy", true],
  ["Hello. World is nice", false],
  ["Hello! World", false],
  ["Hello.World", false],
  ["Hello .World", false],
  ["a. b", false],
  ["почему?", true],
  ["??", false],
  ["!!!", false],
  ["...", false],
  ["2026", false],
  ["тест неразрывный пробел", false],
  ["смесь Latin и Кириллицы 123 _under_score_", false],
  ["ёжик Ёлка ЙОД", false],
  ["Skillbox — Нетология — Яндекс Практикум", false],
  ["AI-поиск: GEO/AEO мониторинг (2026)", false],
  ["  ведущие  пробелы  и  хвост  ", false],
  ["one two", false],
  ["one two three", false],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen", false],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", false],
  ["лучшие сайты с кейсами 2026", true],
  ["купить виртуальную АТС", false],
  ["посоветуй АТС для отдела продаж", true],
  ["Что такое AEO", true],
  ["Сравни Profound и Peec AI", true],
  ["the quick brown fox", false],
  ["TELL me about it", true],
  ["Данные: 12.5% и 3,14 — округление", false],
  ["email me@example.com сейчас", false],
  ["https://ideata.io/blog?utm=1", true],
  ["😀 эмодзи и текст", false],
  ["Ⅻ римские Ⅻ", false],
  ["①②③ круглые цифры", false],
];

const GOLD_LOOKS_HUMAN: ReadonlyArray<[input: string, output: boolean]> = [
  ["", false],
  [" ", false],
  ["   \t\n  ", false],
  ["Нетология, отзывы 2026!", true],
  ["нетология", false],
  ["Нетология", false],
  ["ЧТО ЛУЧШЕ: Skillbox ИЛИ Нетология?", true],
  ["мониторинг бренда crm", false],
  ["Мониторинг бренда: CRM-система для B2B!", false],
  ["notion.so", false],
  ["t.me/ideata", false],
  ["vc.ru — что это?", true],
  ["— озон,", false],
  ["розонный магазин", false],
  ["Ozon vs Wildberries — что дешевле в 2026?", true],
  ["посоветуй CRM для отдела продаж B2B", true],
  ["cs go crash sites", false],
  ["top csgo skin sites 2026", true],
  ["Как заработать? Какие варианты есть?", false],
  ["Работает ли оплата картой в Тинькофф", true],
  ["бартер или деньги что выгоднее", true],
  ["Проанализируй предложения по кредитным картам для путешественников", true],
  ["Изучи варианты обслуживания юрлиц", true],
  ["is skin gambling legal", true],
  ["any good alternatives to notion", true],
  ["I'm looking for a CRM", true],
  ["Best CRM for small business 2026", true],
  ["Скидка 50% — это выгодно?!", true],
  ["цена   сервиса", false],
  ["отзывы сервиса", false],
  ["сайты с краш-игрой на скины cs go", false],
  ["где играть в краш на скины из cs go", true],
  ["which crash site should I use", true],
  ["which crash sites are trustworthy", true],
  ["Hello. World is nice", false],
  ["Hello! World", false],
  ["Hello.World", false],
  ["Hello .World", false],
  ["a. b", false],
  ["почему?", false],
  ["??", false],
  ["!!!", false],
  ["...", false],
  ["2026", false],
  ["тест неразрывный пробел", false],
  ["смесь Latin и Кириллицы 123 _under_score_", false],
  ["ёжик Ёлка ЙОД", false],
  ["Skillbox — Нетология — Яндекс Практикум", false],
  ["AI-поиск: GEO/AEO мониторинг (2026)", false],
  ["  ведущие  пробелы  и  хвост  ", false],
  ["one two", false],
  ["one two three", false],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen", false],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", false],
  ["лучшие сайты с кейсами 2026", true],
  ["купить виртуальную АТС", false],
  ["посоветуй АТС для отдела продаж", true],
  ["Что такое AEO", true],
  ["Сравни Profound и Peec AI", true],
  ["the quick brown fox", false],
  ["TELL me about it", true],
  ["Данные: 12.5% и 3,14 — округление", false],
  ["email me@example.com сейчас", false],
  ["https://ideata.io/blog?utm=1", false],
  ["😀 эмодзи и текст", false],
  ["Ⅻ римские Ⅻ", false],
  ["①②③ круглые цифры", false],
];

const GOLD_CYR_WORDS: ReadonlyArray<[input: GoldText, output: CyrWord[]]> = [
  ["", []],
  [" ", []],
  ["   \t\n  ", []],
  [null, []],
  ["Нетология, отзывы 2026!", [[0,"netologiya"],[11,"otzyvy"]]],
  ["нетология", [[0,"netologiya"]]],
  ["Нетология", [[0,"netologiya"]]],
  ["ЧТО ЛУЧШЕ: Skillbox ИЛИ Нетология?", [[0,"chto"],[4,"luchshe"],[20,"ili"],[24,"netologiya"]]],
  ["мониторинг бренда crm", [[0,"monitoring"],[11,"brenda"]]],
  ["Мониторинг бренда: CRM-система для B2B!", [[0,"monitoring"],[11,"brenda"],[23,"sistema"],[31,"dlya"]]],
  ["notion.so", []],
  ["t.me/ideata", []],
  ["vc.ru — что это?", [[8,"chto"],[12,"eto"]]],
  ["— озон,", [[2,"ozon"]]],
  ["розонный магазин", [[0,"rozonnyy"],[9,"magazin"]]],
  ["Ozon vs Wildberries — что дешевле в 2026?", [[22,"chto"],[26,"deshevle"],[34,"v"]]],
  ["посоветуй CRM для отдела продаж B2B", [[0,"posovetuy"],[14,"dlya"],[18,"otdela"],[25,"prodazh"]]],
  ["cs go crash sites", []],
  ["top csgo skin sites 2026", []],
  ["Как заработать? Какие варианты есть?", [[0,"kak"],[4,"zarabotat"],[16,"kakie"],[22,"varianty"],[31,"est"]]],
  ["Работает ли оплата картой в Тинькофф", [[0,"rabotaet"],[9,"li"],[12,"oplata"],[19,"kartoy"],[26,"v"],[28,"tinkoff"]]],
  ["бартер или деньги что выгоднее", [[0,"barter"],[7,"ili"],[11,"dengi"],[18,"chto"],[22,"vygodnee"]]],
  ["Проанализируй предложения по кредитным картам для путешественников", [[0,"proanaliziruy"],[14,"predlozheniya"],[26,"po"],[29,"kreditnym"],[39,"kartam"],[46,"dlya"],[50,"puteshestvennikov"]]],
  ["Изучи варианты обслуживания юрлиц", [[0,"izuchi"],[6,"varianty"],[15,"obsluzhivaniya"],[28,"yurlits"]]],
  ["is skin gambling legal", []],
  ["any good alternatives to notion", []],
  ["I'm looking for a CRM", []],
  ["Best CRM for small business 2026", []],
  ["Скидка 50% — это выгодно?!", [[0,"skidka"],[13,"eto"],[17,"vygodno"]]],
  ["цена   сервиса", [[0,"tsena"],[7,"servisa"]]],
  ["отзывы сервиса", [[0,"otzyvy"],[7,"servisa"]]],
  ["сайты с краш-игрой на скины cs go", [[0,"sayty"],[6,"s"],[8,"krash"],[13,"igroy"],[19,"na"],[22,"skiny"]]],
  ["где играть в краш на скины из cs go", [[0,"gde"],[4,"igrat"],[11,"v"],[13,"krash"],[18,"na"],[21,"skiny"],[27,"iz"]]],
  ["which crash site should I use", []],
  ["which crash sites are trustworthy", []],
  ["Hello. World is nice", []],
  ["Hello! World", []],
  ["Hello.World", []],
  ["Hello .World", []],
  ["a. b", []],
  ["почему?", [[0,"pochemu"]]],
  ["??", []],
  ["!!!", []],
  ["...", []],
  ["2026", []],
  ["тест неразрывный пробел", [[0,"test"],[5,"nerazryvnyy"],[17,"probel"]]],
  ["смесь Latin и Кириллицы 123 _under_score_", [[0,"smes"],[12,"i"],[14,"kirillitsy"]]],
  ["ёжик Ёлка ЙОД", [[0,"ezhik"],[5,"elka"],[10,"yod"]]],
  ["Skillbox — Нетология — Яндекс Практикум", [[11,"netologiya"],[23,"yandeks"],[30,"praktikum"]]],
  ["AI-поиск: GEO/AEO мониторинг (2026)", [[3,"poisk"],[18,"monitoring"]]],
  ["  ведущие  пробелы  и  хвост  ", [[2,"veduschie"],[11,"probely"],[20,"i"],[23,"hvost"]]],
  ["one two", []],
  ["one two three", []],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen", []],
  ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", []],
  ["лучшие сайты с кейсами 2026", [[0,"luchshie"],[7,"sayty"],[13,"s"],[15,"keysami"]]],
  ["купить виртуальную АТС", [[0,"kupit"],[7,"virtualnuyu"],[19,"ats"]]],
  ["посоветуй АТС для отдела продаж", [[0,"posovetuy"],[10,"ats"],[14,"dlya"],[18,"otdela"],[25,"prodazh"]]],
  ["Что такое AEO", [[0,"chto"],[4,"takoe"]]],
  ["Сравни Profound и Peec AI", [[0,"sravni"],[16,"i"]]],
  ["the quick brown fox", []],
  ["TELL me about it", []],
  ["Данные: 12.5% и 3,14 — округление", [[0,"dannye"],[14,"i"],[23,"okruglenie"]]],
  ["email me@example.com сейчас", [[21,"seychas"]]],
  ["https://ideata.io/blog?utm=1", []],
  ["😀 эмодзи и текст", [[2,"emodzi"],[9,"i"],[11,"tekst"]]],
  ["Ⅻ римские Ⅻ", [[2,"rimskie"]]],
  ["①②③ круглые цифры", [[4,"kruglye"],[12,"tsifry"]]],
];

// [variant, text, bare-regex position, _variant_hit position]
const GOLD_VARIANT_HIT: ReadonlyArray<
  [variant: string, text: string, reIndex: number, hit: number]
> = [
  ["озон", "— озон,", 2, 2],
  ["озон", "розонный магазин", -1, -1],
  ["озон", "озон", 0, 0],
  ["озон", "оЗон", 0, 0],
  ["озон", "маркетплейс озон и вайлдберриз", 12, 12],
  ["notion", "notionally speaking", -1, -1],
  ["notion", "use notion for notes", 4, 4],
  ["notion.so", "открой notion.so сегодня", 7, 7],
  ["notion.so", "notion.social", -1, -1],
  ["vc.ru", "svc.ru зеркало", -1, -1],
  ["vc.ru", "статья на vc.ru про aeo", 10, 10],
  ["t.me/", "пиши в t.me/ideata", 7, 7],
  ["t.me/", "t.me", -1, -1],
  ["insane", "insanely good", -1, -1],
  ["insane", "that is insane!", 8, 8],
  ["netology", "нетология лучший курс", -1, 0],
  ["netology", "netology.ru курсы", 0, 0],
  ["netology", "нетологии не было", -1, 0],
  ["netology", "netologiya и netology", 13, 13],
  ["coursera", "courses are great", -1, -1],
  ["coursera", "курсера и coursera", 10, 10],
  ["crm", "мой crm", 4, 4],
  ["crm", "crm-система", 0, 0],
  ["crm", "microcrm", -1, -1],
  ["ozon", "озон маркет", -1, -1],
  ["ozon", "розон", -1, -1],
  ["ozon", "на ozon дешевле", 3, 3],
  ["tinkoff", "тинькофф банк", -1, 0],
  ["tinkoff", "тинькова", -1, 0],
  ["litres", "литрес книги", -1, 0],
  ["litres", "литр воды", -1, -1],
  ["yandex", "яндекс практикум", -1, 0],
  ["yandex", "яндексу и яндексом", -1, 0],
  ["skillbox", "скиллбокс курсы", -1, 0],
  ["kuper", "купер доставка", -1, 0],
  ["kuper", "купил еду", -1, -1],
  ["", "любой текст", 0, 0],
  ["-dash", "слово -dash тут", 6, 6],
  ["dash-", "тут dash- слово", 4, 4],
  ["a+b", "формула a+b готова", 8, 8],
  ["c++", "язык c++ жив", 5, 5],
  ["[bracket]", "тег [bracket] внутри", 4, 4],
  ["a.b", "axb и a.b", 6, 6],
  ["привет", "привет мир", 0, 0],
  ["привет", "приветствие", -1, -1],
  ["_under", "тут _under score", 4, 4],
  ["2026", "год 2026 настал", 4, 4],
  ["2026", "12026 год", -1, -1],
  ["яндекс", "в яндексе искали", -1, -1],
  ["практикум", "яндекс практикум отзывы", 7, 7],
  ["озон", "😀 озон рядом", 2, 2],
  ["notion", "🚀🚀 use notion here", 7, 7],
  ["netology", "😀😀 нетология тут", -1, 3],
  ["crm", "😀 crm", 2, 2],
];

// [x, ndigits (null = round(x) with one argument), result, result is -0.0]
const GOLD_PY_ROUND: ReadonlyArray<
  [x: number, ndigits: number | null, output: number, negZero: boolean]
> = [
  [12.5, null, 12, false],
  [0.5, null, 0, false],
  [1.5, null, 2, false],
  [2.5, null, 2, false],
  [-0.5, null, 0, false],
  [-1.5, null, -2, false],
  [-2.5, null, -2, false],
  [3.5, null, 4, false],
  [4.5, null, 4, false],
  [0.49999999999999994, null, 0, false],
  [12.5, null, 12, false],
  [37.5, null, 38, false],
  [62.5, null, 62, false],
  [87.5, null, 88, false],
  [4.166666666666667, null, 4, false],
  [12.5, null, 12, false],
  [20.833333333333332, null, 21, false],
  [29.166666666666668, null, 29, false],
  [45.833333333333336, null, 46, false],
  [54.166666666666664, null, 54, false],
  [33.333333333333336, null, 33, false],
  [66.66666666666667, null, 67, false],
  [6.25, null, 6, false],
  [18.75, null, 19, false],
  [3.125, null, 3, false],
  [0, null, 0, false],
  [100, null, 100, false],
  [28.571428571428573, null, 29, false],
  [0, null, 0, false],
  [-0, null, 0, false],
  [1000000000000000.5, null, 1000000000000000, false],
  [123456789.5, null, 123456790, false],
  [2.675, 2, 2.67, false],
  [2.665, 2, 2.67, false],
  [1.005, 2, 1, false],
  [0.125, 2, 0.12, false],
  [0.135, 2, 0.14, false],
  [0.145, 2, 0.14, false],
  [2.5, 1, 2.5, false],
  [0.25, 1, 0.2, false],
  [0.35, 1, 0.3, false],
  [0.45, 1, 0.5, false],
  [0.55, 1, 0.6, false],
  [0.65, 1, 0.7, false],
  [0.75, 1, 0.8, false],
  [-0.04, 1, -0, true],
  [-0.05, 1, -0.1, false],
  [-0.15, 1, -0.1, false],
  [-2.675, 2, -2.67, false],
  [0.3333333333333333, 1, 0.3, false],
  [0.6666666666666666, 1, 0.7, false],
  [0.3333333333333333, 2, 0.33, false],
  [0.6666666666666666, 2, 0.67, false],
  [0.14285714285714285, 2, 0.14, false],
  [3.142857142857143, 2, 3.14, false],
  [2.3333333333333335, 1, 2.3, false],
  [90, 1, 90, false],
  [4.5, 1, 4.5, false],
  [0.2, 2, 0.2, false],
  [1.1, 2, 1.1, false],
  [0.19999999999999998, 2, 0.2, false],
  [100.005, 2, 100, false],
  [12345.6789, 2, 12345.68, false],
  [12345.6789, 1, 12345.7, false],
  [12345.6789, 0, 12346, false],
  [12345.6789, -1, 12350, false],
  [12345.6789, -2, 12300, false],
  [15, -1, 20, false],
  [25, -1, 20, false],
  [250, -2, 200, false],
  [350, -2, 400, false],
  [5, 0, 5, false],
  [5.5, 0, 6, false],
  [6.5, 0, 6, false],
  [-5.5, 0, -6, false],
  [1, null, 1, false],
  [99.5, null, 100, false],
  [98.5, null, 98, false],
];

const label = (v: PyText): string => JSON.stringify(v);

describe('normPrompt — golden pairs from CPython', () => {
  it.each(GOLD_NORM_PROMPT)('normPrompt(%s) === %s', (input, expected) => {
    expect(normPrompt(input)).toBe(expected);
  });
});

describe('contentWords — golden pairs from CPython', () => {
  it.each(GOLD_CONTENT_WORDS.map(([i, o]) => [label(i), i, o] as const))(
    'contentWords(%s)',
    (_name, input, expected) => {
      expect([...contentWords(input)].sort()).toEqual(expected);
    },
  );
});

describe('contentTokens — golden pairs from CPython', () => {
  it.each(GOLD_CONTENT_TOKENS.map(([i, o]) => [label(i), i, o] as const))(
    'contentTokens(%s)',
    (_name, input, expected) => {
      expect(contentTokens(input)).toEqual(expected);
    },
  );
});

describe('looksLikeChat — golden pairs from CPython', () => {
  it.each(GOLD_LOOKS_LIKE_CHAT)('looksLikeChat(%s) === %s', (input, expected) => {
    expect(looksLikeChat(input)).toBe(expected);
  });
});

describe('looksHuman — golden pairs from CPython', () => {
  it.each(GOLD_LOOKS_HUMAN)('looksHuman(%s) === %s', (input, expected) => {
    expect(looksHuman(input)).toBe(expected);
  });
});

describe('cyrWords — golden pairs from CPython', () => {
  it.each(GOLD_CYR_WORDS.map(([i, o]) => [label(i), i, o] as const))(
    'cyrWords(%s)',
    (_name, input, expected) => {
      expect(cyrWords((input ?? '').toLowerCase())).toEqual(expected);
    },
  );
});

describe('variantRe / variantHit — golden pairs from CPython', () => {
  it.each(
    GOLD_VARIANT_HIT.map(
      ([v, t, reIndex, hit]) => [`${label(v)} in ${label(t)}`, v, t, reIndex, hit] as const,
    ),
  )('%s', (_name, variant, text, reIndex, hit) => {
    const low = text.toLowerCase();
    const m = variantRe(variant).exec(low);
    // m.start() in Python is code points; RegExp.index is UTF-16 units.
    expect(m ? pyIndex(low, m.index) : -1).toBe(reIndex);
    expect(variantHit(low, cyrWords(low), variant)).toBe(hit);
  });
});

describe('pyRound — golden pairs from CPython', () => {
  it.each(
    GOLD_PY_ROUND.map(
      ([x, n, out, negZero]) =>
        [`round(${x}${n === null ? '' : `, ${n}`}) === ${negZero ? '-0.0' : out}`, x, n, out, negZero] as const,
    ),
  )('%s', (_name, x, n, expected, negZero) => {
    const got = n === null ? pyRound(x) : pyRound(x, n);
    expect(got).toBe(expected);
    // Python's round(-0.04, 1) returns exactly -0.0; we don't lose the sign of zero.
    expect(Object.is(got, -0)).toBe(negZero);
  });
});

// ── traps for a naive port (fixtures duplicated on purpose for a readable failure) ───

describe('trap: \\w and \\b are ASCII-only in JS', () => {
  it('normPrompt does not wipe out Cyrillic', () => {
    // A naive [^\w\s] in JS would have left "2026" and the spaces.
    expect(normPrompt('Нетология, отзывы 2026!')).toBe('нетология отзывы 2026');
  });

  it('contentTokens catches Russian words the same as Latin ones', () => {
    expect(contentTokens('мониторинг бренда crm')).toEqual([
      'мониторинг',
      'бренда',
      'crm',
    ]);
  });

  it('normPrompt collapses punctuation into a space instead of gluing words together', () => {
    expect(normPrompt('CRM-система для B2B!')).toBe('crm система для b2b');
    expect(normPrompt('notion.so')).toBe('notion so');
  });

  it('normPrompt gives an empty string on empty and None-like input', () => {
    expect(normPrompt('')).toBe('');
    expect(normPrompt(null)).toBe('');
    expect(normPrompt(undefined)).toBe('');
    expect(normPrompt('   \t\n  ')).toBe('');
  });
});

describe('trap: word boundaries around a Cyrillic variant', () => {
  it('"озон" is found in "— озон,"', () => {
    const low = '— озон,';
    expect(variantRe('озон').test(low)).toBe(true);
    expect(variantHit(low, cyrWords(low), 'озон')).toBe(2);
  });

  it('"озон" is NOT found inside "розонный"', () => {
    const low = 'розонный магазин';
    expect(variantRe('озон').test(low)).toBe(false);
    expect(variantHit(low, cyrWords(low), 'озон')).toBe(-1);
  });

  it('a variant with a non-word edge does not require a boundary', () => {
    // For "t.me/" the right edge is a slash: \b there would mean the exact opposite.
    expect(variantRe('t.me/').test('пиши в t.me/ideata')).toBe(true);
  });

  it('transliteration catches the Russian spelling of a brand', () => {
    const low = 'нетология лучший курс';
    expect(variantHit(low, cyrWords(low), 'netology')).toBe(0);
  });

  it('transliteration does not truncate Latin: courses ≠ coursera', () => {
    const low = 'courses are great';
    expect(variantHit(low, cyrWords(low), 'coursera')).toBe(-1);
  });
});

describe('trap: banker\'s rounding', () => {
  it('round(12.5) === 12, not 13', () => {
    expect(pyRound(12.5)).toBe(12);
    expect(Math.round(12.5)).toBe(13); // this is NOT how you're allowed to compute it
  });

  it('halves on real-world denominators round to even', () => {
    expect(pyRound((100 * 1) / 8)).toBe(12); // 12.5 → 12
    expect(pyRound((100 * 3) / 8)).toBe(38); // 37.5 → 38
    expect(pyRound((100 * 5) / 8)).toBe(62); // 62.5 → 62
  });

  it('round(x, n) computes on the exact double value', () => {
    expect(pyRound(2.675, 2)).toBe(2.67); // not 2.68: the exact value is lower
    expect(pyRound(0.125, 2)).toBe(0.12); // an exact half → rounds to even
    expect((2.675).toFixed(2)).toBe('2.67');
  });

  it('negative ndigits rounds to tens', () => {
    expect(pyRound(25, -1)).toBe(20);
    expect(pyRound(35, -1)).toBe(40);
  });
});
