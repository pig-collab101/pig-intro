// food_web.html 의 먹이그물·희귀도 + 생김새 데이터를 합쳐 eco_species.js 생성
// 사용법 (저장소 맨 위에서): node eco/tools/gen_species.js eco/food_web.html eco/eco_species.js
// 그다음 api/_eco_species.json 도 다시 만들어야 함 (종 순서 = 랭킹 번호, 새 종은 항상 먹이그물 맨 끝에 추가)
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const out = process.argv[3];
const raw = src.split('const RAW = `')[1].split('`;')[0].trim();
const basal = src.match(/const BASAL = (\[[^\]]*\]);/)[1];
const rarity = src.match(/const RARITY_DEF = (\[[\s\S]*?\n\]);/)[1];

const LOOK = `
사자|b4|2.5|#c9a05a|#7a4f22|none|mane,tuft
치타|b4|2.0|#e0b866|#2a2218|spot|slim
표범|b4|2.0|#d9a94e|#3a2a18|spot|slim
하이에나|b4|1.6|#b59a6e|#4a3a2a|spot|mane2
아프리카들개|s4|1.2|#8a6a3e|#2a2218|spot|bigear
자칼|s4|1.0|#b98a50|#3a3028|belly|bigear,fluffytail
서벌|s4|0.9|#d9b66a|#2a2218|spot|bigear,longleg
카라칼|s4|0.9|#c08a50|#2a1a10|none|tuftear
코끼리|b4|6.0|#8d8a86|#f2ede0|none|trunk,bigear,tusk,thickleg
기린|ln|5.0|#e0b060|#7a4a20|spot|ossicone
얼룩말|b4|2.3|#f2f0ea|#1e1e1e|stripe|mane2
누|b4|2.2|#5a5650|#2a2826|none|horn2s,beard,mane2
물소|b4|3.0|#3e3a36|#2a2826|none|horn2s,thickleg
코뿔소|b4|3.8|#8a8780|#6a6760|none|horn1,thickleg
가젤|b4|1.2|#c8955a|#f3eadc|belly|horn2,slim
임팔라|b4|1.4|#b87a46|#f3eadc|belly|horn2,slim
혹멧돼지|b4|1.4|#6a5a4a|#3a2e24|none|tusk,shortleg,mane2
타조|wb|2.2|#2a2624|#f2efe8|none|longneck,longleg
미어캣|s4|0.3|#c9a77a|#5a4630|none|upright
개코원숭이|pr|0.9|#8a7a5a|#c06a6a|none|tail,quad
케이프토끼|s4|0.5|#a88a62|#f0e8dc|belly|longear,shorttail
초원쥐|s4|0.15|#8a7058|#e8dccb|belly|thintail
프레리도그|s4|0.35|#b08a5a|#e8d8c0|belly|upright,shorttail
아르마딜로|s4|0.7|#8a7a6a|#6a5a4a|stripe|armor,shortleg
큰개미핥기|s4|1.8|#5a4a3a|#f0eadc|stripe|snout,fluffytail
흰개미|iv|0.01|#efe2c8|#a07040|none|ant
메뚜기|iv|0.05|#7ea040|#5a7a2a|none|hopper
쇠똥구리|iv|0.03|#1e2220|#3a3e3c|none|beetle
뿔닭|wb|0.5|#3a3c44|#e8e8f0|spot|round
흰등수리|fb|1.0|#6a5a4a|#f0eadc|none|hookbeak,bigwing
아가마도마뱀|re|0.3|#4a5aa8|#e07a30|stripe|
비서새|wb|1.3|#c8c8c4|#1e1e1e|none|longleg,crest,hookbeak
코브라|sn|2.0|#6a5a3a|#c8b080|none|hood
베짜기새|fb|0.15|#e8c838|#3a2a1a|none|
들소|b4|3.2|#5a3e28|#3a2818|none|hump,horn2s,beard,mane2,shaggy
늑대|s4|1.6|#8a8a86|#e8e6e0|belly|fluffytail
불곰|b4|2.5|#6a4a2e|#4a321e|none|bear
반달가슴곰|b4|1.7|#1e1e1e|#f2f0ea|none|bear,moon
퓨마|b4|1.8|#b88a58|#f0e6d6|belly|slim,longtail
스라소니|s4|1.0|#a8906e|#5a4630|spot|tuftear,shorttail,longleg
붉은여우|s4|0.8|#d06a2a|#f4efe8|belly|fluffytail
오소리|s4|0.8|#7a7a76|#1e1e1e|stripe|shortleg,bulky
너구리|s4|0.6|#7a7068|#2a2622|stripe|fluffytail,mask
담비|s4|0.6|#7a4a26|#e8c870|belly|slim,fluffytail
족제비|s4|0.35|#9a6a3a|#f2e8d8|belly|slim,shortleg
울버린|s4|0.9|#4a3a2e|#a88a5a|stripe|bear
스컹크|s4|0.6|#1e1e1e|#f4f4f0|stripe|fluffytail
고슴도치|s4|0.25|#7a6a5a|#c8b8a0|none|spiky,shortleg
두더지|s4|0.15|#3a3432|#e8b0a0|none|shortleg,snout
붉은사슴|b4|2.2|#9a5a32|#e8d8c0|belly|antler,slim
고라니|b4|1.0|#b08a5a|#e8dccb|belly|tusk,slim
엘크|b4|2.5|#8a6a48|#4a3424|none|antler,mane2
무스|b4|3.0|#4a3628|#2a1e16|none|palmantler,beard,longleg
멧돼지|b4|1.5|#4a3e34|#2a2420|none|tusk,shortleg,mane2
산토끼|s4|0.5|#9a7a5a|#f0e8dc|belly|longear,shorttail
다람쥐|s4|0.2|#b8783a|#2a1e16|stripe|fluffytail
청설모|s4|0.25|#4a3e36|#e8e0d0|belly|fluffytail,tuftear
하늘다람쥐|s4|0.15|#a8a098|#f4f0e8|belly|fluffytail,glider
들쥐|s4|0.12|#7a6050|#d8c8b8|belly|thintail
박쥐|fb|0.1|#3a3230|#5a4a42|none|bat
수리부엉이|fb|0.7|#8a6a42|#3a2a1a|spot|owl,tuftear
올빼미|fb|0.4|#9a8a7a|#4a3a30|spot|owl
검독수리|fb|0.9|#5a3e26|#c8a060|none|hookbeak,bigwing
매|fb|0.45|#5a6270|#f0eae0|stripe|hookbeak
딱따구리|fb|0.25|#1e1e1e|#d03030|spot|crest,longbeak
꿩|wb|0.8|#8a3a2a|#2a6a5a|none|longtail,round
박새|fb|0.14|#3a4a3a|#e8d850|belly|
어치|fb|0.33|#c8a088|#3a6ac8|none|crest
까마귀|fb|0.5|#1e1e22|#2a2a36|none|
꿀벌|iv|0.015|#e8b020|#1e1e1e|stripe|wings
개미|iv|0.01|#3a1e14|#1e1210|none|ant
딱정벌레|iv|0.03|#2a6a3a|#1e2a20|none|beetle
나방|iv|0.04|#a89a7e|#6a5a48|none|wings,bigwings
지렁이|sn|0.2|#c88078|#a86058|stripe|worm
달팽이|iv|0.04|#b8a890|#8a5a3a|stripe|snail
호랑이|b4|3.0|#e08030|#1e1e1e|stripe|slim,longtail
재규어|b4|2.0|#d8a848|#2a1e14|spot|longtail
검은표범|b4|2.0|#1c1c20|#2a2a30|none|slim,longtail
오셀롯|s4|0.9|#c8a060|#3a2a1a|spot|longtail
아나콘다|sn|6.0|#5a6a2a|#1e1e14|spot|thick
보아뱀|sn|3.0|#a08a6a|#5a3a2a|spot|thick
킹코브라|sn|4.0|#5a5a2a|#d8d0a0|stripe|hood
그물무늬비단뱀|sn|6.0|#8a7a4a|#3a2a1a|spot|thick
나무뱀|sn|1.5|#3aa040|#a8d860|none|
하피수리|fb|1.0|#6a6a6a|#f0f0f0|belly|hookbeak,crest,bigwing
고릴라|pr|1.8|#2a2a2a|#5a5a5a|none|bulky,quad
침팬지|pr|1.2|#2e2622|#d8b8a0|none|
오랑우탄|pr|1.4|#b0582a|#7a3a1a|none|longarm,bulky
긴팔원숭이|pr|0.8|#3a3430|#e8e0d8|none|longarm
꼬리감는원숭이|pr|0.45|#3a2a20|#f0e0c8|none|tail
나무늘보|pr|0.7|#8a7a5e|#5a4a3a|none|longarm,hang
맥|b4|2.0|#2a2a2e|#f0f0f0|belly|snout,shortleg
문착|b4|1.0|#b0703a|#e8d8c0|belly|tusk,slim
페커리|b4|1.0|#4a4440|#d8d0c8|none|shortleg,mane2
아구티|s4|0.5|#a8703a|#6a4422|none|shorttail,longleg
큰부리새|fb|0.6|#1e1e1e|#f0a020|none|bigbeak
앵무새|fb|0.8|#d82a2a|#2a6ad8|none|hookbeak,longtail
공작|wb|1.1|#1a6ab0|#2a9a5a|none|fan,crest
과일박쥐|fb|0.3|#5a3a2a|#2a1e18|none|bat
카멜레온|re|0.4|#5ab04a|#e0c040|stripe|chameleon
독화살개구리|am|0.04|#2a6ae0|#1e1e1e|spot|
이구아나|re|1.6|#4a9a4a|#2a5a2a|stripe|crest
모르포나비|iv|0.15|#2a7ae8|#1e1e1e|none|wings,bigwings
잎꾼개미|iv|0.012|#a04020|#6a2a14|none|ant,leaf
대벌레|iv|0.15|#6a8a3a|#4a6a2a|none|stick
사막여우|s4|0.4|#e8cfa0|#f8f2e8|belly|hugeear,fluffytail
낙타|b4|3.0|#c8a070|#a8805a|none|hump,longneck,longleg
오릭스|b4|1.8|#d8ccb8|#1e1e1e|stripe|horn2long
모래가젤|b4|1.1|#e0c8a0|#f6f0e6|belly|horn2,slim
코요테|s4|1.0|#a8906a|#e8dcc8|belly|fluffytail,bigear
방울뱀|sn|1.4|#b89a6a|#5a4430|spot|rattle
힐라몬스터|re|0.5|#e88a50|#1e1e1e|spot|
전갈|iv|0.1|#c8a050|#8a6a30|none|scorpion
타란툴라|iv|0.1|#3a2a22|#a07040|none|spider
거저리|iv|0.025|#1e1a18|#3a3430|none|beetle
사막메뚜기|iv|0.06|#c8a840|#8a7020|none|hopper
캥거루쥐|s4|0.15|#d0b080|#f4ece0|belly|longleg,thintail
사막쥐|s4|0.12|#c8a070|#f0e6d8|belly|thintail
잭토끼|s4|0.6|#b8a07a|#f0e8dc|belly|hugeear,shorttail,longleg
도깨비도마뱀|re|0.2|#c8904a|#7a4a2a|spot|spiky
수확개미|iv|0.01|#a83a1e|#6a2010|none|ant
모래도마뱀|re|0.25|#d8c090|#8a7050|spot|
메추라기|wb|0.25|#7a6a5a|#3a3434|spot|round,crest
로드러너|wb|0.55|#6a5a4a|#f0e8dc|spot|crest,longtail,longbeak
해리스매|fb|0.55|#4a3022|#a0582a|none|hookbeak
북극곰|b4|2.6|#f4f2ea|#d8d4c8|none|bear
북극늑대|s4|1.6|#f2f0ea|#d8d4cc|none|fluffytail
북극여우|s4|0.7|#f6f6f2|#dcdcd8|none|fluffytail
흰올빼미|fb|0.6|#f6f6f2|#3a3a3a|spot|owl
흰매|fb|0.55|#f0f0ec|#5a5a60|spot|hookbeak
순록|b4|2.0|#9a8a74|#f0ece4|belly|antler
사향소|b4|2.3|#3a2e26|#c8b8a0|none|shaggy,horn2s
눈산양|b4|1.4|#f4f2ec|#2a2a2a|none|horn2,beard,shaggy
북극토끼|s4|0.6|#f6f6f2|#2a2a2a|none|longear,shorttail
레밍|s4|0.13|#b08a5a|#2a2a2a|stripe|shortleg,shorttail
뇌조|wb|0.4|#f4f4f0|#2a2a2a|none|round
바다표범|wh|1.8|#7a7a7a|#4a4a4a|spot|seal
바다코끼리|wh|3.0|#a87a5a|#f0e8d8|none|seal,tusk
황제펭귄|wb|1.2|#1e2226|#f6f4ee|none|penguin
아델리펭귄|wb|0.7|#1e2226|#f6f4ee|none|penguin
표범물범|wh|3.0|#6a6c70|#c8c8c8|spot|seal
퍼핀|wb|0.3|#1e1e22|#f6f4ee|none|penguin,bigbeak
북방족제비|s4|0.3|#f4f2ea|#1e1e1e|none|slim,shortleg
설표|b4|1.3|#d8d4cc|#4a4a4a|spot|longtail,fluffytail
야크|b4|3.0|#2a2420|#f0eae0|none|shaggy,horn2s,hump
하마|b4|4.0|#8a6a70|#d89a9a|belly|thickleg,shortleg,bigmouth
나일악어|re|5.0|#4a5a34|#c8c098|none|croc
카이만|re|2.2|#5a5a3a|#c8c098|none|croc
카피바라|s4|1.2|#8a5e3a|#6a4428|none|shorttail,bulky
비버|s4|1.0|#6a4428|#3a2a1e|none|flattail,bulky
수달|s4|1.0|#5a3e28|#c8b090|belly|slim,longtail,shortleg
밍크|s4|0.45|#3a2418|#2a1a12|none|slim,shortleg
물총새|fb|0.16|#1a8ad8|#e8803a|belly|longbeak
흰머리수리|fb|0.9|#3a2a1e|#f6f4ee|none|hookbeak,whitehead,bigwing
물수리|fb|0.6|#4a3e34|#f0ece4|belly|hookbeak
청둥오리|wb|0.6|#7a6a5a|#1e7a3e|none|duck
연어|fi|0.8|#c8606a|#8a9aa8|spot|
송어|fi|0.5|#8aa088|#e88a8a|spot|
메기|fi|1.2|#5a5244|#c8c0a8|none|whisker
피라냐|fi|0.3|#8a9098|#d84a3a|belly|deep
송사리|fi|0.04|#b8b8a0|#e0e0c8|none|
가재|iv|0.12|#a83a24|#6a2214|none|crayfish
황소개구리|am|0.2|#5a7a3a|#3a5a2a|spot|
잠자리|iv|0.08|#3a8ad8|#1e2a3a|none|wings,longbody
모기|iv|0.008|#4a4440|#2a2624|stripe|wings,stick
두루미|wb|1.4|#f4f4f0|#1e1e1e|none|longneck,longleg,redcap
왜가리|wb|1.0|#9aa0a8|#3a3a40|none|longneck,longleg,longbeak
홍학|wb|1.2|#f08aa0|#1e1e1e|none|longneck,longleg,bentbeak
자라|re|0.3|#6a6a4a|#c8c098|none|shell,flatshell
도롱뇽|am|0.15|#3a3a30|#e8c040|spot|salamander
미꾸라지|fi|0.15|#8a7a5a|#5a4a3a|spot|eel,whisker
우렁이|iv|0.04|#5a4a32|#8a7a5a|none|snail
유혈목이|sn|0.9|#4a5a3a|#d84a2a|spot|
사향쥐|s4|0.5|#5a3e2a|#3a2a1e|none|thintail,bulky
펠리컨|wb|1.6|#f4f2ec|#f0c040|none|pouch,longbeak
범고래|wh|8.0|#1a1a1e|#f6f6f2|belly|tallfin,eyepatch
백상아리|fi|5.0|#6a7480|#f2f2ee|belly|shark
귀상어|fi|4.0|#7a8088|#e8e8e4|belly|shark,hammer
고래상어|fi|12.0|#3a4a5a|#e8e8e4|spot|shark,wide
흰긴수염고래|wh|25.0|#5a6a7e|#8a9aa8|spot|baleen
혹등고래|wh|15.0|#2a2e36|#e8e8e4|belly|longflipper,fin
향유고래|wh|16.0|#4a4a50|#6a6a70|none|boxhead
돌고래|wh|2.5|#7a8a9a|#e8ecf0|belly|beak,fin
물개|wh|1.8|#5a4a3e|#3a2e26|none|seal,ears
참치|fi|2.0|#2a3a5a|#c8d0d8|belly|fast
청어|fi|0.3|#5a7a9a|#e0e8f0|belly|
고등어|fi|0.35|#2a6a6a|#e8ecf0|stripe|
멸치|fi|0.12|#8aa0b0|#e8f0f4|belly|
대구|fi|1.0|#8a8060|#e8e4d8|spot|whisker
오징어|iv|0.5|#e0a090|#a85a4a|spot|squid
대왕오징어|iv|12.0|#c0503a|#7a2a1e|none|squid
문어|iv|1.0|#c8603a|#8a3a22|spot|octopus
게|iv|0.2|#c84a2a|#8a2a14|none|crab
조개|iv|0.08|#d8c8b0|#8a7a6a|stripe|clam
바다거북|re|1.2|#5a6a3a|#c8b890|spot|shell,flipper
해파리|iv|0.3|#e8b0e8|#f4d0f4|none|jelly
가오리|fi|1.5|#6a5a4a|#f0ece4|spot|ray
크릴|iv|0.05|#f08a6a|#c85a3a|none|krill
성게|iv|0.08|#4a2a4a|#2a1a2a|none|urchin
해달|s4|1.2|#5a4232|#c8b8a0|none|slim,shortleg
두꺼비|am|0.12|#7a6448|#4e3e2a|spot|toad
`.trim();

const file = `// 생태계 3D — 동물 200종 데이터
// 먹이그물·희귀도는 food_web.html 과 같은 내용이에요. (먹이그물을 고치면 이 파일도 다시 만들어야 해요)

// 이름|바이옴|식성|먹이(공백 구분)
const ECO_WEB = \`
${raw}
\`;

const ECO_BASAL = ${basal};

// [등급, 확률(%), 색, 종 목록] — 목록에 없는 종은 일반
const ECO_RARITY = ${rarity};

// 이름|체형 틀|실제 몸길이(m)|주색|보조색|무늬(none·stripe·spot·belly)|부위(쉼표 구분)
const ECO_LOOK = \`
${LOOK}
\`;

const ECO_TEMPLATES = {
  s4: '작은 네발', b4: '큰 네발', ln: '목 긴 네발', pr: '영장류',
  wb: '걷는 새', fb: '나는 새', fi: '물고기', wh: '고래형',
  sn: '뱀형', re: '파충류', am: '양서류', iv: '곤충·무척추',
};

const ECO = (() => {
  const species = [], byName = {}, errors = [];
  ECO_WEB.trim().split('\\n').forEach(line => {
    const [name, biome, diet, prey] = line.split('|');
    const s = { name, biome, diet, prey: prey.split(' '), pred: [], rarity: '일반' };
    species.push(s); byName[name] = s;
  });
  ECO_RARITY.forEach(([r, , , list]) => list && list.split(' ').forEach(n => byName[n] ? byName[n].rarity = r : errors.push('희귀도: ' + n)));
  ECO_LOOK.trim().split('\\n').forEach(line => {
    const [name, tpl, size, c1, c2, pattern, parts] = line.split('|');
    if (!byName[name]) return errors.push('생김새: ' + name);
    if (!ECO_TEMPLATES[tpl]) errors.push('체형 틀: ' + name + ' ' + tpl);
    Object.assign(byName[name], { tpl, size: +size, c1, c2, pattern, parts: parts ? parts.split(',') : [] });
  });
  species.forEach(s => {
    if (!s.tpl) errors.push('생김새 없음: ' + s.name);
    s.prey.forEach(p => byName[p] ? byName[p].pred.push(s.name) : ECO_BASAL.includes(p) || errors.push('먹이: ' + s.name + ' → ' + p));
  });
  if (errors.length) console.warn('[ECO] 데이터 오류', errors);
  return { species, byName, errors, basal: ECO_BASAL, rarity: ECO_RARITY, templates: ECO_TEMPLATES };
})();
`;
fs.writeFileSync(out, file);
const looks = LOOK.split('\n').length, webs = raw.split('\n').length;
const tplCount = {};
LOOK.split('\n').forEach(l => { const t = l.split('|')[1]; tplCount[t] = (tplCount[t] || 0) + 1; });
console.log('web', webs, 'look', looks, JSON.stringify(tplCount));
