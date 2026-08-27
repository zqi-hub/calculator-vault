/* words.js — 邀请码助记词词库（常见易拼写英文单词，加载时自动去重）
   用途：随机抽取若干单词组成一次性邀请码，同时作为 PBKDF2 口令派生信令加密密钥。
   注意：本词库仅用于会话配对，与 BIP39 等钱包助记词标准无关，勿作他用。 */
const WORDS = (() => {
  const raw = `
able acid aged airy also area army atom aunt away baby back bake ball band bank bark barn base bath
beam bean bear beat been beer bell belt bend best bird bite blew blue boat body bold bomb bond bone
book boom boot born boss both bowl bulb bulk burn bush busy cage cake calm came camp card care cart
case cash cast cave cell cent chat chef chew chin chip city clam clap clay club clue coal coat code
coin cold comb come cook cool cope copy cord core cork corn cost crab crew crop crow cube curl cute
damp dare dark dart dash data date dawn days deal dear debt deck deep deer desk dial dice diet dirt
dish dock doll done door dove down draw drop drum duck dust duty each earn ease east easy echo edge
edit eggs else emit ends envy epic even ever exam exit face fact fair fall fame farm fast fate fear
feed feel feet fell felt file fill film find fine fire firm fish fist five flag flat flew flip flow
foam fold folk fond food fool foot ford fork form fort four free frog from fuel full fund gain game
gate gave gear gift girl give glad glow glue goal goat goes gold golf gone good grab gray grew grid
grin grow gulf hail hair half hall hand hang hard harm harp hate have hawk head heal heap hear heat
held help herd here hero hide high hike hill hint hold hole home hood hook hope horn host hour huge
hunt hurt icon idea idle inch into iron item jazz join joke jump june jury just keen keep kept kick
kind king kiss kite knee knew knot know lace lack lady laid lake lamb lamp land lane last late lawn
lead leaf lean left lend lens less liar lick life lift like limb lime line link lion list live load
loaf loan lock long look lord lose loss lost loud love luck made mail main make male mall many mark
mask mass mate math meal mean meat meet melt memo menu mesh mild mile milk mind mine mint miss mist
mode mold moon more most moth move much mud must myth nail name navy near neat neck need nest news
next nice nine node none noon norm nose note noun nuts oak oats obey odds oily okay once only onto
open oral ours oven over pace pack page paid pain pair pale palm park part pass past path peak pear
peas peer pest pick pile pine pink pipe plan play plot plug plum plus poem poet pole poll pond pool
poor port pose post pour pray pull pump pure push quit quiz race rack rain rank rare rate read real
reef rent rest rice rich ride ring rise risk road rock role roll roof room root rope rose rule rush
rust safe said sail salt same sand save seal seat seed seek seem self sell send sent ship shoe shop
shot show shut sick side sign silk sing sink site size skin skip slam slip slow snow soap sock sofa
soft soil sold some song soon sort soul soup sour spin spot star stay stem step stop such suit sure
swim tail take tale talk tall tank tape task team tear tell tend tent term test text than that them
then they thin this tide tidy tied tile till time tiny tire told toll tone took tool tops torn tour
town trap tray tree trip true tune turn twin type ugly unit upon used user vast verb very view vote
wage wait wake walk wall want ward warm warn wash wave weak wear week well went were west what when
whip wide wife wild will wind wine wing wink wire wise wish with wolf wood wool word wore work yard
yarn year yell your zero zone zoom
`;
  return [...new Set(raw.trim().split(/\s+/))];
})();
