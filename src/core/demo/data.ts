/**
 * 演示模式假数据集（第 319 轮，演示域）。
 *
 * buildDemoDataset(now) 是纯函数：以当前时刻为锚点相对生成，一条时间线讲一个
 * 完整的虚构学期故事 —— 大三上（2026-2027-1）四门课并进 + 上一学期线代归档 +
 * B 站站外学习线。覆盖面与点亮目标：
 *  - 我的课程：5 门课卡片 + 课次展开（finished / watching / unwatched 三态、断点续看）
 *  - 课表与补看：本周课表（curriculum）+ 3 条逾期补看（missed 判定：已结束超
 *    missDelayHours 且 watchRatio < finishThreshold）
 *  - 知识库：6 种收藏类型全覆盖、5 个课程文件夹、6 个标签、置顶、笔记、B 站视频收藏
 *    （第 317/318 轮课程筛选 chips、标签统计板随之点亮）
 *  - 复习计划：regular / exam / custom 三模板，待完成横跨 逾期/今天/未来 三档
 *    + 已完成 + 已跳过（三区、紧急度、周视图全点亮）
 *  - 学习统计：近 90 天站内流水（工作日晚间为主、周末轻、偶尔中断）+ B 站站外时长
 *    + videoProgress + 进行中的每周回看计划
 *  - 播放页七 tab：数据结构与算法（上周 · 观看中）一节挂全套转写 / AI 标注 / 问答 /
 *    笔记 —— 从「继续学习」进入即见；搜索命中、时间轴标注随之点亮
 *  - 截图：只产元数据（缩略图占位由 seed.ts 在 SW 内用 OffscreenCanvas 生成，
 *    环境不支持则该条跳过，不阻塞其余播种）
 *
 * 全部人物、课程、数据均为虚构；ID 统一 demo- 前缀（与真实数据可肉眼区分）。
 */

import type {
  AiResultEntity,
  ChatMessageEntity,
  CourseEntity,
  CurriculumItem,
  ExternalNoteEntity,
  ExternalWatchEntity,
  FavoriteEntity,
  FolderEntity,
  NoteEntity,
  ReviewJobEntity,
  SessionEntity,
  TagEntity,
  TranscriptEntity,
  VideoProgressEntity,
  WatchRecordEntity,
} from '../shared/types';
import type { WeeklyPlan } from '../plan/weekly';
import { biliMediaKey, hduMediaKey } from '../shared/mediaRef';
import { buildCourLabel, localDayKey } from '../shared/utils';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** 确定性伪随机（mulberry32）：同一 now 种出同一份流水，单测可断言 */
function mulberry32(seedNum: number): () => number {
  let a = seedNum >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 当地零点毫秒 */
function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地周一零点（周一为一周之首） */
function mondayOf(now: number): number {
  return localMidnight(now) - ((new Date(localMidnight(now)).getDay() + 6) % 7) * DAY_MS;
}

/** 某周（0 = 本周）周 weekday（1=周一…7=周日）的 hour:minute 毫秒时刻 */
function tsInWeek(monday: number, weekBack: number, weekday: number, hour: number, minute = 0): number {
  return monday - weekBack * 7 * DAY_MS + (weekday - 1) * DAY_MS + hour * HOUR_MS + minute * MIN_MS;
}

/** offsetDays 天前（相对 now）的 hour:minute 时刻 */
function tsDaysAgo(now: number, offsetDays: number, hour = 20, minute = 0): number {
  const d = new Date(now - offsetDays * DAY_MS);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** 'YYYY-MM-DD'（本地时区，offsetDays 天前）—— 与 localDayKey 口径一致 */
function dayKeyAgo(now: number, offsetDays: number): string {
  return localDayKey(now - offsetDays * DAY_MS);
}

// ───────────────────────── 虚构课程世界 ─────────────────────────

/** 课次周脚本：watchRatio 覆盖默认（已看完 = 1） */
type WeekPlan = Partial<Record<number, { state: SessionEntity['watchState']; ratio: number }>>;

interface CourseDef {
  teclId: number;
  /** 课次 ID 基址：第 w 周（0 = 本周）课次 courId = courIdBase + w */
  courIdBase: number;
  subjName: string;
  subjCode: string;
  teacher: string;
  clroName: string;
  /** 上课星期（1=周一…7=周日）与时刻 */
  weekday: number;
  hour: number;
  minute: number;
  durationSec: number;
  semester: string;
  /** 生成多少周课次（含本周 w=0） */
  weeksBack: number;
  /** 起始周回退（缺省 0 = 含本周；上学期课程传 1 跳过本周） */
  weeksFrom?: number;
  /** 各周覆盖脚本：缺省 = 过去已看完 / 未来未看 */
  script: WeekPlan;
  /** 学期第几周（courLabel 展示用基值：本周周数） */
  weekNumberNow: number;
}

/** 本学期四门课 + 上一学期已完结线代（虚构） */
const COURSES: CourseDef[] = [
  {
    teclId: 9101, courIdBase: 1227041, subjName: '高等数学（下）', subjCode: 'MATH1002',
    teacher: '徐建国', clroName: '第6教学楼 302', weekday: 3, hour: 18, minute: 30,
    durationSec: 3240, semester: '2026-2027-1', weeksBack: 8,
    script: { 2: { state: 'unwatched', ratio: 0.45 } }, weekNumberNow: 11,
  },
  {
    teclId: 9102, courIdBase: 1227051, subjName: '数据结构与算法', subjCode: 'CS2001',
    teacher: '吴晓梅', clroName: '第4教学楼 512', weekday: 2, hour: 14, minute: 0,
    durationSec: 3060, semester: '2026-2027-1', weeksBack: 8,
    script: { 1: { state: 'watching', ratio: 0.62 } }, weekNumberNow: 11,
  },
  {
    teclId: 9103, courIdBase: 1227061, subjName: '大学物理Ⅱ', subjCode: 'PHYS1002',
    teacher: '郑海涛', clroName: '第2教学楼 105', weekday: 4, hour: 10, minute: 0,
    durationSec: 2940, semester: '2026-2027-1', weeksBack: 8,
    script: { 3: { state: 'unwatched', ratio: 0.2 } }, weekNumberNow: 11,
  },
  {
    teclId: 9104, courIdBase: 1227071, subjName: '大学英语（视听）', subjCode: 'ENG1008',
    teacher: '刘一鸣', clroName: '第1教学楼 204', weekday: 5, hour: 8, minute: 0,
    durationSec: 2520, semester: '2026-2027-1', weeksBack: 8,
    script: { 1: { state: 'unwatched', ratio: 0.3 } }, weekNumberNow: 11,
  },
  {
    // 上一学期已完结：只生成过去 6 周（不占本周），全部看完 —— 历史归档 + 课程筛选演示
    teclId: 9105, courIdBase: 1227081, subjName: '线性代数', subjCode: 'MATH1001',
    teacher: '宋雅琴', clroName: '第3教学楼 201', weekday: 1, hour: 10, minute: 0,
    durationSec: 2820, semester: '2025-2026-2', weeksBack: 6, weeksFrom: 1,
    script: {}, weekNumberNow: 16,
  },
];

/** 课次 courId（第 319 轮演示固定引用点） */
const DS_W1 = 1227052; // 数据结构 · 上周（观看中，播放页全套演示挂这节）
const MATH_W1 = 1227042; // 高数 · 上周（已看完，带转写）
const PHYS_W2 = 1227063; // 物理 · 三周前（带转写）
const LA_W1 = 1227082; // 线代 · 上学期最近一节（带转写）

const BILI_BVID_MAIN = 'BV1DEMO7X4Kq';
const BILI_BVID_DS = 'BV1DEMO2LpVe';
const BILI_BVID_PHYS = 'BV1DEMO9PhYs';
const BILI_MAIN_KEY = biliMediaKey(BILI_BVID_MAIN);

/** 演示模式侧栏规范模板来源（切换任意 HDU 课次或 B 站视频/分 P 时复用同一套完整演示数据） */
export const DEMO_HDU_CANONICAL_COUR_ID = DS_W1;
export const DEMO_BILI_CANONICAL_BVID = BILI_BVID_MAIN;

/** [起秒, 止秒, 台词] */
type Seg = [number, number, string];

const DS_SEGMENTS: Seg[] = [
  [0, 48, '同学们好，今天我们讲第五章：二叉树。这是数据结构里最重要的章节，没有之一。'],
  [48, 112, '先回顾树的定义：n 个节点的有限集合，有一个特定的根，其余节点分成 m 个互不相交的子树。'],
  [112, 175, '二叉树是每个节点最多有两个子树的树结构，子树有左右之分，次序不能颠倒——这一点和普通树不同。'],
  [175, 240, '两个特殊形态要记住：满二叉树，每层节点都达到最大；完全二叉树，只允许最后一层缺右边连续的若干节点。'],
  [240, 305, '性质一：第 i 层最多有 2 的 i 减 1 次方个节点。性质二：深度为 k 的二叉树最多 2 的 k 次方减 1 个节点。'],
  [305, 375, '完全二叉树有个好性质：可以用数组存储，节点下标 i 的左孩子是 2i，右孩子是 2i+1，双亲是 i 除以 2 向下取整。'],
  [375, 448, '但是一般树形结构还是用链式存储：每个节点存数据域和左右指针，这就是二叉链表。'],
  [448, 520, '重点来了：遍历。先序遍历，根左右；中序遍历，左根右；后序遍历，左右根。三个字母的顺序就是根节点被访问的时机。'],
  [520, 596, '递归写法三行就完事，但面试常考非递归。中序遍历的非递归：用一个栈，一路向左入栈，弹出访问，再转向右子树。'],
  [596, 668, '注意弹出时机的差别：先序是入栈前访问，中序是弹出时访问，后序要额外记录上一个访问过的右孩子。'],
  [668, 742, '层序遍历用队列：根入队，出队时访问并把左右孩子依次入队。它其实是图的广度优先搜索的特例。'],
  [742, 820, '由两种遍历序列可以唯一确定一棵二叉树，但必须包含中序——先序加后序是不行的，反例课堂上有。'],
  [820, 900, '接下来是本节主角：二叉搜索树，简称 BST。左子树所有节点小于根，右子树所有节点大于根，递归成立。'],
  [900, 985, 'BST 的查找就是折半查找的推广：比根小往左走，比根大往右走，平均时间复杂度 O(log n)，最坏退化成 O(n)。'],
  [985, 1065, '插入同理：空位就是它最终的位置。注意相同元素我们约定存到右子树，或者节点里加计数域。'],
  [1065, 1148, '删除是 BST 最复杂的操作，分三种情况：叶子直接删；只有一个孩子，孩子顶上；有两个孩子，找中序后继来替换。'],
  [1148, 1225, '为什么找中序后继？因为中序遍历下后继恰好是比被删节点大的最小节点，替换后仍然保持 BST 的有序性质。'],
  [1225, 1300, '中序后继一定在右子树里：一路向左走到头。把它删掉、值抄到被删节点，问题规模就缩小了。'],
  [1300, 1380, '课堂例题：按序列 50, 30, 70, 20, 40, 60, 80 依次插入，画出这棵 BST，再删除 50，两种做法都试试。'],
  [1380, 1460, '顺带提醒：删除 50 用「前驱替换」和「后继替换」会得到两棵不同形态但都合法的 BST，判卷都给分。'],
  [1460, 1545, '最后埋一个伏笔：BST 在最坏情况会退化成链表，比如按有序序列插入。怎么保证永远「矮胖」？下节课讲 AVL 树。'],
  [1545, 1620, '作业：教材 132 页 5、6、8 题，第八题要求写出非递归中序遍历的完整代码。下课。'],
];

const MATH_SEGMENTS: Seg[] = [
  [0, 52, '上次课我们把定积分讲完了，今天进入下册最后一编：无穷级数。'],
  [52, 118, '级数就是把无穷多个数加起来：u1 加 u2 一直加到 un。部分和数列 S_n 有极限，就说级数收敛。'],
  [118, 186, '注意，无穷相加不是「加很多」，而是一个极限过程。级数敛散性的定义完全落在部分和数列上。'],
  [186, 252, '第一个重要结论：级数收敛的必要条件是通项趋于零。反过来说，通项不趋于零，级数一定发散。'],
  [252, 318, '但通项趋于零只是必要不充分——调和级数 1/n 通项趋于零却发散，这是最经典的反例，考试常考。'],
  [318, 390, '判别正项级数，首选比较判别法：通项不大于某个收敛级数的通项，则收敛；不小于发散级数的通项，则发散。'],
  [390, 462, '实用工具是比值判别法，也叫达朗贝尔判别法：后项比前项的极限小于 1 收敛，大于 1 发散，等于 1 失效。'],
  [462, 535, '等于 1 时要换根值判别法，还不行就回到比较判别法，找 p 级数或者等比级数做参照。'],
  [535, 610, 'p 级数要背下来：p 大于 1 收敛，p 小于等于 1 发散。它是比较判别法最常用的标尺。'],
  [610, 690, '下面进入交错级数：正负相间。莱布尼茨判别法两个条件：通项单调递减且趋于零，则收敛。'],
  [690, 768, '交错 p 级数，绝对值级数收敛叫绝对收敛；绝对值发散但本身收敛叫条件收敛——两者的区别必须清楚。'],
  [768, 845, '绝对收敛的级数可以任意重排而不改变和；条件收敛的重排可能得到任何预设的和，这是黎曼的著名结果。'],
  [845, 925, '例题：判断 1 减 1/2 加 1/3 减 1/4 的敛散性。绝对值是调和级数发散，本身满足莱布尼茨收敛——条件收敛。'],
  [925, 1010, '再强调一次判别顺序：先看通项是否趋于零，再看正负，正项用比较和比值，交错用莱布尼茨，最后讨论绝对收敛。'],
  [1010, 1090, '下节课讲幂级数：收敛半径、收敛域，以及为什么幂级数在收敛区间内可以逐项求导积分。'],
  [1090, 1160, '作业：教材 248 页，第 2 题奇数小题，第 4 题全部。重点体会「失效后换工具」的思路。下课。'],
];

const PHYS_SEGMENTS: Seg[] = [
  [0, 50, '上次课我们讲完了稳恒磁场，今天进入电磁感应——法拉第十年寻找「磁生电」的成果。'],
  [50, 118, '实验事实：穿过闭合回路的磁通量发生变化，回路中就产生感应电流。注意关键词是「变化」，不是「有」。'],
  [118, 188, '法拉第电磁感应定律：感应电动势等于磁通量对时间变化率的负值，负号的物理内涵就是楞次定律。'],
  [188, 255, '楞次定律：感应电流的效果总是反抗引起它的磁通变化。它本质上是能量守恒在电磁学里的表现。'],
  [255, 328, '磁通变化有两种来源：磁场本身变化，或者回路相对磁场运动。前者产生感生电动势，后者产生动生电动势。'],
  [328, 400, '动生电动势的非静电力是洛伦兹力：导体内自由电荷随导体运动，受洛伦兹力沿导体方向分量的推动。'],
  [400, 475, '注意洛伦兹力总功为零，动生电动势的能量来自外力做功——这是同学最常混淆的点。'],
  [475, 552, '感生电动势更深刻：变化的磁场在空间激发感生电场，也叫涡旋电场，它的电场线是闭合的，不同于静电场。'],
  [552, 628, '感生电场是无源有旋场，麦克斯韦正是从这里迈出第一步，预言了电磁波的存在。'],
  [628, 705, '例题：长直导线通电流 I，旁边共面矩形线圈以速度 v 平移，求感应电动势。先写磁通，再对时间求导。'],
  [705, 782, '解这类题的套路固定：先找 B 的分布，再算磁通 Phi，然后 dPhi/dt。负号交给楞次定律判方向。'],
  [782, 858, '接下来讲自感：线圈自身电流变化引起自身磁通变化，自感系数 L 定义为磁链与电流之比。'],
  [858, 935, '自感的单位是亨利。长直螺线管的自感 L 等于 mu n 方 V，只由线圈几何和介质决定，与电流无关。'],
  [935, 1015, '互感是两个线圈之间的耦合：M12 等于 M21，这就是互感系数的互易性。变压器就是互感的应用。'],
  [1015, 1090, '自感磁能等于二分之一 L I 方。磁场能量密度等于 B 方除以 2 mu——类比电场能量密度来记。'],
  [1090, 1165, '最后强调考试要点：判定感应电流方向一律用楞次定律；算大小一律用法拉第定律取模。两步分开做，不要混。'],
  [1165, 1230, '下周实验课测螺线管自感系数，预习报告要提前写。下课。'],
];

const LA_SEGMENTS: Seg[] = [
  [0, 42, '大家好，今天我们进入第三章：矩阵的运算。'],
  [42, 96, '先回顾一下矩阵的定义：m 行 n 列的数表，记作 A。'],
  [96, 168, '矩阵乘法的定义：A 是 m×n 矩阵，B 是 n×p 矩阵，乘积 C=AB 的第 i 行第 j 列元素，等于 A 的第 i 行与 B 的第 j 列的对应乘积之和。'],
  [168, 235, '注意，矩阵乘法要求左边的列数等于右边的行数，这是可乘的前提条件。'],
  [235, 320, '重点来了：矩阵乘法不满足交换律。举一个二阶矩阵的反例，AB 和 BA 算出来是两个不同的矩阵。'],
  [320, 388, '但是结合律和分配律是成立的，即 (AB)C = A(BC)，这个在证明题里会反复用到。'],
  [388, 465, '接下来看单位矩阵 E：任何矩阵乘以单位矩阵都保持不变，它在矩阵运算里的地位相当于数字 1。'],
  [465, 540, '下面介绍矩阵的转置：把行变成列。转置有一个重要性质：(AB)ᵀ = BᵀAᵀ，注意顺序要反过来。'],
  [540, 625, '如果两个矩阵相乘等于单位矩阵，我们就说它们互为逆矩阵，记作 A⁻¹。'],
  [625, 700, '可逆的充要条件是行列式不等于零，这是本章最重要的判定之一。'],
  [700, 780, '逆矩阵的求法：伴随矩阵除以行列式，二阶矩阵有非常简洁的口诀。'],
  [780, 860, '最后引入特征值：如果 Av = λv，v 是非零向量，那么 λ 就叫特征值，v 是对应的特征向量。'],
  [860, 940, '特征方程是 |A−λE| = 0，解这个多项式方程就能得到全部特征值。'],
  [940, 1020, '特征值的几何直观：它描述线性变换中方向不变的那些方向，缩放的比例就是特征值。'],
  [1020, 1105, '下一节我们讲相似对角化，预习时请思考：什么样的矩阵可以对角化？下课。'],
];

const BILI_SEGMENTS: Seg[] = [
  [0, 12, '大家好，这节课我们讲线性代数的核心专题：特征值与相似对角化。'],
  [12, 28, '先明确定义：对于 n 阶方阵 A，若存在数 λ 和非零向量 v 使得 Av 等于 λv，λ 叫特征值，v 叫特征向量。'],
  [28, 42, '求特征值的标准入口是解特征方程：行列式 |A − λE| = 0，展开后得到关于 λ 的 n 次多项式。'],
  [42, 58, '来看二阶矩阵例题：特征多项式展开是 λ² − 5λ + 6 = 0，因式分解得特征值 λ₁ = 2，λ₂ = 3。'],
  [58, 74, '把 λ₁ = 2 和 λ₂ = 3 分别代回齐次线性方程组 (A − λE)x = 0，解基础解系即可得到对应特征向量。'],
  [74, 92, '因为两个特征值互不相等，求出的两个特征向量必然线性无关；如果出现重根，就要检查基础解系的维数是否够用。'],
  [92, 112, '相似对角化的充要条件：n 阶矩阵 A 恰有 n 个线性无关的特征向量，拼成可逆矩阵 P，则 P⁻¹AP = Λ。'],
  [112, 132, '特别提醒考研高频结论：实对称矩阵一定可以相似对角化，而且不同特征值对应的特征向量自动正交。'],
  [132, 152, '如果实对称矩阵存在重根特征值，只需在各自特征子空间内做施密特正交化并单位化，再拼成正交矩阵 Q。'],
  [152, 172, '因为正交矩阵满足 Qᵀ = Q⁻¹，所以我们能一步写出 QᵀAQ = Λ，计算量比一般矩阵逆矩阵小得多。'],
  [172, 194, '常见失分点自查：求出特征向量后务必回代验算 Av = λv，同时确认拼 P 或 Q 时特征值与向量列次序一一对应。'],
  [194, 218, '掌握对角化之后，求 A 的 k 次幂就变成 PΛᵏP⁻¹，只算对角元幂次即可，递推和微分方程都会用到。'],
  [218, 240, '下节课我们接续讲二次型化标准形与正定判定。喜欢这节课记得三连，完整讲义和习题解析在置顶评论。'],
];

/** segments 数组 → 转写实体（coverage 与末段对齐；updatedAt = createdAt） */
function transcriptOf(
  mediaKey: TranscriptEntity['mediaKey'],
  courId: number | undefined,
  segs: Seg[],
  durationSec: number,
  source: TranscriptEntity['source'],
  createdAt: number,
): TranscriptEntity {
  const lastEnd = segs.length ? (segs[segs.length - 1]?.[1] ?? 0) : 0;
  return {
    mediaKey,
    ...(courId !== undefined ? { courId } : {}),
    segments: segs.map(([s, e, text]) => ({ s, e, text })),
    model: source === 'bili-official-subtitle' ? 'bili-official-subtitle' : 'whisper-standard',
    lang: 'zh-CN',
    glossaryVersion: 0,
    createdAt,
    updatedAt: createdAt,
    source,
    coveredSec: lastEnd,
    coverage: [{ start: 0, end: lastEnd }],
    durationSec,
    aiSubtitle: false,
    partial: false,
    pipelineVersion: 1,
  };
}

// ───────────────────────── 主数据集 ─────────────────────────

/** 演示截图元数据（blob 由 seed.ts 生成后并成完整 ScreenshotEntity；必填字段收紧为必备） */
export interface DemoScreenshotMeta {
  id: string;
  courId: number;
  view: number;
  thumbDataUrl?: string;
  meta: { courseName: string; courLabel: string; anchorTime: number; watermark: boolean };
  createdAt: number;
}

export interface DemoDataset {
  courses: CourseEntity[];
  sessions: SessionEntity[];
  transcripts: TranscriptEntity[];
  aiResults: AiResultEntity[];
  chats: ChatMessageEntity[];
  favorites: FavoriteEntity[];
  folders: FolderEntity[];
  tags: TagEntity[];
  notes: NoteEntity[];
  externalNotes: ExternalNoteEntity[];
  /** 截图元数据（blob 由 seed.ts 生成；生成失败则整条跳过） */
  screenshotMetas: DemoScreenshotMeta[];
  watchRecords: WatchRecordEntity[];
  reviewJobs: ReviewJobEntity[];
  curriculum: CurriculumItem[];
  videoProgress: VideoProgressEntity[];
  externalWatch: ExternalWatchEntity[];
  weeklyPlans: WeeklyPlan[];
  kv: Array<{ key: string; value: unknown }>;
}

/**
 * 以 now 为锚点构建完整演示数据集。纯函数：不读库、不写库、不依赖环境，
 * 同一 now 输入恒等输出（watchRecords 内部用固定种子伪随机）。
 */
export function buildDemoDataset(now: number): DemoDataset {
  const monday = mondayOf(now);

  // ── 课程实体 ──
  const courses: CourseEntity[] = COURSES.map((c, i) => ({
    teclId: c.teclId,
    subjName: c.subjName,
    subjCode: c.subjCode,
    teacherNames: [c.teacher],
    clroName: c.clroName,
    semester: c.semester,
    teclCode: `TECL-${c.teclId}`,
    updatedAt: tsDaysAgo(now, 1 + i * 3, 9 + i),
  }));

  // ── 课次 ──
  const sessions: SessionEntity[] = [];
  for (const c of COURSES) {
    for (let w = c.weeksFrom ?? 0; w <= c.weeksBack; w += 1) {
      const begin = tsInWeek(monday, w, c.weekday, c.hour, c.minute);
      const end = begin + c.durationSec * 1000;
      const courId = c.courIdBase + w;
      let state: SessionEntity['watchState'];
      let ratio: number;
      if (begin > now) {
        state = 'unwatched';
        ratio = 0;
      } else {
        const plan = c.script[w];
        if (plan) {
          state = plan.state;
          ratio = plan.ratio;
        } else {
          state = 'finished';
          ratio = 1;
        }
      }
      const rec: SessionEntity = {
        courId,
        teclId: c.teclId,
        beginTime: new Date(begin).toISOString(),
        endTime: new Date(end).toISOString(),
        letiNumber: Math.max(2, c.weekNumberNow - w),
        letyName: '理论课',
        durationSec: c.durationSec,
        watchState: state,
        courseName: c.subjName,
        courLabel: buildCourLabel({
          weekNumber: c.weekNumberNow - w,
          beginTime: begin,
          letiNumber: Math.max(2, c.weekNumberNow - w),
          clroName: c.clroName,
        }),
        watchRatio: ratio,
        updatedAt: Math.min(now - 5 * MIN_MS, end + HOUR_MS),
      };
      if (state !== 'unwatched') {
        rec.firstWatchedAt = Math.min(end, now - 2 * HOUR_MS);
        rec.lastPositionSec = Math.round(c.durationSec * ratio);
      }
      // 全套演示挂的两节：记录 AI 标注锚点（时间轴标注点亮）
      if (courId === DS_W1) rec.lastAiAnchor = 900;
      if (courId === MATH_W1) rec.lastAiAnchor = 610;
      sessions.push(rec);
    }
  }

  // ── 转写 / AI / 问答 ──
  const transcripts: TranscriptEntity[] = [
    transcriptOf(hduMediaKey(DS_W1), DS_W1, DS_SEGMENTS, 3060, 'local-asr', tsDaysAgo(now, 1, 15, 40)),
    transcriptOf(hduMediaKey(MATH_W1), MATH_W1, MATH_SEGMENTS, 3240, 'local-asr', tsDaysAgo(now, 2, 19, 10)),
    transcriptOf(hduMediaKey(PHYS_W2), PHYS_W2, PHYS_SEGMENTS, 2940, 'local-asr', tsDaysAgo(now, 17, 11, 5)),
    transcriptOf(hduMediaKey(LA_W1), LA_W1, LA_SEGMENTS, 2820, 'local-asr', tsDaysAgo(now, 130, 11, 5)),
    transcriptOf(BILI_MAIN_KEY, undefined, BILI_SEGMENTS, 980, 'bili-official-subtitle', tsDaysAgo(now, 4, 21, 30)),
  ];

  const aiResults: AiResultEntity[] = [
    {
      mediaKey: hduMediaKey(DS_W1),
      courId: DS_W1,
      promptVersion: 1,
      model: '演示标注模型',
      topics: [
        { name: '二叉树的定义与形态', summary: '满二叉树与完全二叉树的判定；数组存储下标规律（2i / 2i+1）。', confidence: 'high', intervals: [[48, 375]] },
        { name: '三种遍历与非递归写法', summary: '先/中/后序的根访问时机；中序非递归「一路向左入栈」，弹出即访问。', confidence: 'high', intervals: [[448, 742]] },
        { name: '二叉搜索树（BST）', summary: '左小右大递归成立；查找/插入 O(log n)，有序插入退化 O(n)。', confidence: 'high', intervals: [[820, 1065]] },
        { name: 'BST 删除与中序后继', summary: '双子节点删中序后继（右子树一路向左），替换后有序性保持。', confidence: 'high', intervals: [[1065, 1460]] },
        { name: '平衡化预告', summary: '最坏退化链表 → 下节 AVL 树引入旋转。', confidence: 'medium', intervals: [[1460, 1620]] },
      ],
      outline: [
        { level: 1, title: '二叉树基础', start: 0, end: 448 },
        { level: 2, title: '定义与两种特殊形态', start: 48, end: 240, parent: 0 },
        { level: 2, title: '性质与存储结构', start: 240, end: 448, parent: 0 },
        { level: 1, title: '遍历算法', start: 448, end: 820 },
        { level: 2, title: '先序 / 中序 / 后序', start: 448, end: 596, parent: 3 },
        { level: 2, title: '非递归与层序', start: 596, end: 820, parent: 3 },
        { level: 1, title: '二叉搜索树', start: 820, end: 1620 },
        { level: 2, title: '定义、查找与插入', start: 820, end: 1065, parent: 6 },
        { level: 2, title: '删除：三种情形与中序后继', start: 1065, end: 1460, parent: 6 },
        { level: 2, title: '失衡问题与 AVL 预告', start: 1460, end: 1620, parent: 6 },
      ],
      createdAt: tsDaysAgo(now, 1, 16, 2),
    },
    {
      mediaKey: hduMediaKey(MATH_W1),
      courId: MATH_W1,
      promptVersion: 1,
      model: '演示标注模型',
      topics: [
        { name: '级数收敛的定义', summary: '部分和数列极限决定敛散性；通项趋于零是必要条件（调和级数反例）。', confidence: 'high', intervals: [[52, 318]] },
        { name: '正项级数判别法', summary: '比较判别法为纲，比值（达朗贝尔）为器，p 级数是标尺。', confidence: 'high', intervals: [[318, 610]] },
        { name: '交错级数与莱布尼茨', summary: '单调递减趋于零则收敛；绝对收敛 vs 条件收敛。', confidence: 'high', intervals: [[610, 845]] },
        { name: '典型例题', summary: '1 − 1/2 + 1/3 − 1/4 … 为条件收敛的完整论证。', confidence: 'medium', intervals: [[845, 1010]] },
      ],
      outline: [
        { level: 1, title: '无穷级数概念', start: 0, end: 318 },
        { level: 2, title: '部分和与敛散性', start: 52, end: 186, parent: 0 },
        { level: 2, title: '收敛必要条件', start: 186, end: 318, parent: 0 },
        { level: 1, title: '判别法体系', start: 318, end: 610 },
        { level: 2, title: '比较判别法', start: 318, end: 390, parent: 3 },
        { level: 2, title: '比值判别法与 p 级数', start: 390, end: 610, parent: 3 },
        { level: 1, title: '交错级数', start: 610, end: 845 },
        { level: 1, title: '例题与判别流程', start: 845, end: 1160 },
      ],
      createdAt: tsDaysAgo(now, 2, 19, 40),
    },
    {
      mediaKey: hduMediaKey(PHYS_W2),
      courId: PHYS_W2,
      promptVersion: 1,
      model: '演示标注模型',
      topics: [
        { name: '法拉第定律与楞次定律', summary: '电动势 = −dΦ/dt；负号即「反抗磁通变化」，能量守恒的表现。', confidence: 'high', intervals: [[50, 255]] },
        { name: '动生与感生电动势', summary: '洛伦兹力沿导体分量 vs 涡旋感生电场；能量来源的区别。', confidence: 'high', intervals: [[255, 552]] },
        { name: '自感与互感', summary: 'L 的定义与螺线管公式；互易性 M12 = M21；磁能 ½LI²。', confidence: 'high', intervals: [[782, 1090]] },
      ],
      outline: [
        { level: 1, title: '电磁感应基础', start: 0, end: 255 },
        { level: 2, title: '实验事实与定律', start: 50, end: 188, parent: 0 },
        { level: 2, title: '楞次定律', start: 188, end: 255, parent: 0 },
        { level: 1, title: '两类感应电动势', start: 255, end: 782 },
        { level: 2, title: '动生电动势', start: 255, end: 400, parent: 3 },
        { level: 2, title: '感生电场', start: 400, end: 552, parent: 3 },
        { level: 2, title: '例题套路', start: 552, end: 782, parent: 3 },
        { level: 1, title: '自感与互感', start: 782, end: 1230 },
      ],
      createdAt: tsDaysAgo(now, 17, 11, 30),
    },
    {
      mediaKey: hduMediaKey(LA_W1),
      courId: LA_W1,
      promptVersion: 1,
      model: '演示标注模型',
      topics: [
        { name: '矩阵乘法的定义', summary: '可乘条件与行乘列法则，C=AB 的第 i 行 j 列元素求法。', confidence: 'high', intervals: [[96, 235]] },
        { name: '交换律不成立', summary: '二阶矩阵反例：AB ≠ BA；结合律与分配律成立。', confidence: 'high', intervals: [[235, 388]] },
        { name: '转置与逆矩阵', summary: '(AB)ᵀ=BᵀAᵀ；A⁻¹ 存在当且仅当 det A ≠ 0。', confidence: 'high', intervals: [[465, 780]] },
        { name: '特征值与特征向量', summary: 'Av=λv；特征方程 |A−λE|=0；几何直观是不变方向的缩放。', confidence: 'medium', intervals: [[780, 1105]] },
      ],
      outline: [
        { level: 1, title: '矩阵运算', start: 0, end: 465 },
        { level: 2, title: '乘法定义与可乘条件', start: 96, end: 235, parent: 0 },
        { level: 2, title: '交换律反例', start: 235, end: 388, parent: 0 },
        { level: 1, title: '转置与逆', start: 465, end: 780 },
        { level: 2, title: '转置的性质', start: 465, end: 540, parent: 3 },
        { level: 2, title: '逆矩阵与行列式', start: 540, end: 780, parent: 3 },
        { level: 1, title: '特征值初步', start: 780, end: 1105 },
      ],
      createdAt: tsDaysAgo(now, 130, 11, 40),
    },
    {
      mediaKey: BILI_MAIN_KEY,
      promptVersion: 1,
      model: '演示标注模型',
      topics: [
        { name: '特征值与特征方程', summary: 'Av = λv 定义，由 |A − λE| = 0 求特征值与基础解系。', confidence: 'high', intervals: [[12, 58]] },
        { name: '二阶矩阵求解示范', summary: '展开特征多项式得 λ₁ = 2、λ₂ = 3 并反代求特征向量。', confidence: 'high', intervals: [[42, 92]] },
        { name: '相似对角化判据与构造', summary: 'n 阶矩阵有 n 个线性无关特征向量即可对角化，P⁻¹AP = Λ。', confidence: 'high', intervals: [[74, 132]] },
        { name: '实对称矩阵正交对角化', summary: '不同特征值向量自动正交，施密特正交化构造 QᵀAQ = Λ 与回代验算。', confidence: 'medium', intervals: [[112, 218]] },
      ],
      outline: [
        { level: 1, title: '特征值基础与特征方程', start: 0, end: 58 },
        { level: 2, title: '定义 Av = λv 与特征多项式', start: 12, end: 42, parent: 0 },
        { level: 2, title: '二阶算例完整求解', start: 42, end: 58, parent: 0 },
        { level: 1, title: '相似对角化条件与实对称结论', start: 58, end: 172 },
        { level: 2, title: 'P⁻¹AP = Λ 与重根判据', start: 58, end: 112, parent: 3 },
        { level: 2, title: '实对称矩阵正交化拼 Q', start: 112, end: 172, parent: 3 },
        { level: 1, title: '回代验算、求幂应用与二次型预告', start: 172, end: 240 },
      ],
      createdAt: tsDaysAgo(now, 4, 21, 45),
    },
  ];

  const chats: ChatMessageEntity[] = [
    { id: 'demo-chat-1', mediaKey: hduMediaKey(DS_W1), courId: DS_W1, groupId: 'demo-group-ds-1', role: 'user', content: '中序遍历的非递归实现里，什么时候入栈、什么时候访问？', anchorTime: 520, status: 'done', createdAt: tsDaysAgo(now, 1, 20, 6) },
    { id: 'demo-chat-2', mediaKey: hduMediaKey(DS_W1), courId: DS_W1, groupId: 'demo-group-ds-1', role: 'ai', content: '记忆口诀：一路向左入栈，弹出即访问，再转向右子树（依据字幕 08:40）。对比先序是「入栈前访问」，后序要额外记录上一个访问过的右孩子防止兜回（依据字幕 09:56）。', anchorTime: 520, contextActual: [448, 668], evidence: { start: 520, end: 668 }, status: 'done', createdAt: tsDaysAgo(now, 1, 20, 7) },
    { id: 'demo-chat-1b', mediaKey: hduMediaKey(DS_W1), courId: DS_W1, groupId: 'demo-group-ds-1', role: 'user', content: '后序非递归具体怎么靠记录“上一个右孩子”避免重复压栈？', anchorTime: 610, status: 'done', createdAt: tsDaysAgo(now, 1, 20, 8) },
    { id: 'demo-chat-2b', mediaKey: hduMediaKey(DS_W1), courId: DS_W1, groupId: 'demo-group-ds-1', role: 'ai', content: '看栈顶节点时先检查右孩子：如果右孩子为空或者等于 prev（刚访问过），说明右子树已处理完，此时弹出访问根节点并更新 prev = root；否则才把指针转向右孩子继续入栈（依据字幕 09:56）。', anchorTime: 610, contextActual: [448, 668], evidence: { start: 596, end: 668 }, status: 'done', createdAt: tsDaysAgo(now, 1, 20, 9) },
    { id: 'demo-chat-3', mediaKey: hduMediaKey(DS_W1), courId: DS_W1, groupId: 'demo-group-ds-2', role: 'user', content: 'BST 删除双子节点，为什么替换值用中序后继而不是随便挑一个？', anchorTime: 1148, status: 'done', createdAt: tsDaysAgo(now, 1, 20, 42) },
    { id: 'demo-chat-4', mediaKey: hduMediaKey(DS_W1), courId: DS_W1, groupId: 'demo-group-ds-2', role: 'ai', content: '因为中序后继是「比被删节点大的最小节点」，用替换后整棵树仍满足左<根<右的有序性质；任取其他值都可能破坏 BST 定义（依据字幕 19:08）。后继一定在右子树一路向左的尽头，删除它等价于规模缩小的问题。', anchorTime: 1148, contextActual: [1065, 1300], evidence: { start: 1065, end: 1300 }, status: 'done', createdAt: tsDaysAgo(now, 1, 20, 43) },
    { id: 'demo-chat-9', mediaKey: hduMediaKey(DS_W1), courId: DS_W1, groupId: 'demo-group-ds-3', role: 'user', content: '为什么说 BST 按有序序列插入会退化成链表？后面 AVL 树怎么解决？', anchorTime: 1460, status: 'done', createdAt: tsDaysAgo(now, 1, 21, 14) },
    { id: 'demo-chat-10', mediaKey: hduMediaKey(DS_W1), courId: DS_W1, groupId: 'demo-group-ds-3', role: 'ai', content: '因为每次新值都比当前节点大（或小），会单边挂在右子树（或左子树），树高退化成 n，查找从 O(log n) 掉到 O(n)（依据字幕 15:00、24:20）。下节课的 AVL 树会在失衡时通过旋转保持「矮胖」高度平衡。', anchorTime: 1460, contextActual: [820, 1620], evidence: { start: 900, end: 1545 }, status: 'done', createdAt: tsDaysAgo(now, 1, 21, 15) },
    { id: 'demo-chat-5', mediaKey: hduMediaKey(MATH_W1), courId: MATH_W1, groupId: 'demo-group-math-1', role: 'user', content: '条件收敛和绝对收敛到底差在哪？重排真会改变和吗？', anchorTime: 690, status: 'done', createdAt: tsDaysAgo(now, 2, 20, 31) },
    { id: 'demo-chat-6', mediaKey: hduMediaKey(MATH_W1), courId: MATH_W1, groupId: 'demo-group-math-1', role: 'ai', content: '绝对收敛 = 加绝对值后仍收敛，重排不改变和；条件收敛 = 本身收敛但绝对值级数发散，黎曼定理说它可以重排出任何预设的和（依据字幕 12:48）。判断顺序：先判绝对值级数，发散再回莱布尼茨（依据字幕 15:25）。', anchorTime: 690, contextActual: [610, 925], evidence: { start: 768, end: 925 }, status: 'done', createdAt: tsDaysAgo(now, 2, 20, 32) },
    { id: 'demo-chat-7', mediaKey: BILI_MAIN_KEY, groupId: 'demo-group-bili-1', role: 'user', content: '实对称矩阵为什么一定可以对角化？', anchorTime: 112, status: 'done', createdAt: tsDaysAgo(now, 4, 21, 52) },
    { id: 'demo-chat-8', mediaKey: BILI_MAIN_KEY, groupId: 'demo-group-bili-1', role: 'ai', content: '实对称矩阵不同特征值的特征向量自动正交（正交即线性无关），重根也能补齐 n 个无关向量，所以 n 个线性无关特征向量恒成立（依据字幕 01:52）。这也是施密特正交化能配它用的原因。', anchorTime: 112, contextActual: [74, 172], evidence: { start: 112, end: 172 }, status: 'done', createdAt: tsDaysAgo(now, 4, 21, 53) },
    { id: 'demo-chat-11', mediaKey: BILI_MAIN_KEY, groupId: 'demo-group-bili-1', role: 'user', content: '正交化并单位化之后拼成的 Q 矩阵，在写成对角阵时要注意什么？', anchorTime: 152, status: 'done', createdAt: tsDaysAgo(now, 4, 21, 54) },
    { id: 'demo-chat-12', mediaKey: BILI_MAIN_KEY, groupId: 'demo-group-bili-1', role: 'ai', content: '正交矩阵直接用转置代替求逆（QᵀAQ = Λ），但要注意两件事：向量必须先单位化再拼列，且对角阵 Λ 上特征值的次序必须和 Q 的各特征向量列严格对齐，写完顺手回代验算 Av = λv（依据字幕 02:32、02:52）。', anchorTime: 152, contextActual: [92, 194], evidence: { start: 132, end: 194 }, status: 'done', createdAt: tsDaysAgo(now, 4, 21, 55) },
    { id: 'demo-chat-13', mediaKey: BILI_MAIN_KEY, groupId: 'demo-group-bili-2', role: 'user', content: '遇到重根特征值时，怎么判断普通矩阵能不能相似对角化？', anchorTime: 74, status: 'done', createdAt: tsDaysAgo(now, 4, 21, 40) },
    { id: 'demo-chat-14', mediaKey: BILI_MAIN_KEY, groupId: 'demo-group-bili-2', role: 'ai', content: '核心看每个 k 重特征值代入 (A − λE)x = 0 后求出的基础解系维数是否等于重数 k（依据字幕 01:14）。如果全部重根都不缺维，就能凑满 n 个线性无关特征向量；只要有一个维数小于重数，就不能相似对角化。', anchorTime: 74, contextActual: [28, 132], evidence: { start: 58, end: 112 }, status: 'done', createdAt: tsDaysAgo(now, 4, 21, 41) },
  ];

  // ── 文件夹 / 标签 ──
  const folders: FolderEntity[] = COURSES.map((c, i) => ({
    id: `demo-folder-${c.teclId}`,
    teclId: c.teclId,
    name: `${c.subjName}（${c.semester}）`,
    orderIndex: i,
    archived: false,
    createdAt: tsDaysAgo(now, 60 - i * 5, 10),
  }));

  const tags: TagEntity[] = [
    { id: 'demo-tag-key', name: '重点', color: '#c2571b' },
    { id: 'demo-tag-exam', name: '考点', color: '#8d2f57' },
    { id: 'demo-tag-error', name: '易错', color: '#a33b1f' },
    { id: 'demo-tag-case', name: '案例', color: '#3d6f3d' },
    { id: 'demo-tag-net', name: '网课', color: '#3a5f8f' },
    { id: 'demo-tag-interview', name: '面试', color: '#6b5a8f' },
  ];

  // ── 笔记 ──
  const notes: NoteEntity[] = [
    { id: 'demo-note-1', courId: DS_W1, teclId: 9102, anchorTime: 900, text: 'BST 删除双子节点：右子树一路向左找中序后继，值抄过来再删后继。作业 8 题要写非递归中序。', createdAt: tsDaysAgo(now, 1, 21, 2), updatedAt: tsDaysAgo(now, 1, 21, 2) },
    { id: 'demo-note-2', courId: DS_W1, teclId: 9102, anchorTime: 1545, text: 'AVL 预告：插入序列有序时 BST 退化成链表，旋转保证「矮胖」。下节课开头大概率要点名讲四种旋转。', createdAt: tsDaysAgo(now, 1, 21, 8), updatedAt: tsDaysAgo(now, 1, 21, 8) },
    { id: 'demo-note-3', courId: DS_W1, teclId: 9102, anchorTime: 668, text: '先序+后序不能唯一确定二叉树——课堂反例：只有左链的树和只有右链的树先序后序相同。', createdAt: tsDaysAgo(now, 1, 21, 20), updatedAt: tsDaysAgo(now, 1, 21, 20) },
    { id: 'demo-note-4', courId: MATH_W1, teclId: 9101, anchorTime: 252, text: '调和级数发散的证明：分组 1/2, (1/3+1/4), (1/5..1/8)… 每组大于 1/2，无穷多组超过任何上界。', createdAt: tsDaysAgo(now, 2, 21, 15), updatedAt: tsDaysAgo(now, 2, 21, 15) },
    { id: 'demo-note-5', courId: MATH_W1, teclId: 9101, anchorTime: 925, text: '判别流程背下来：通项→0? → 正项(比较/比值) → 交错(莱布尼茨) → 绝对收敛讨论。作业 248 页 2 奇数、4 全部。', createdAt: tsDaysAgo(now, 2, 21, 26), updatedAt: tsDaysAgo(now, 2, 21, 26) },
    { id: 'demo-note-6', courId: PHYS_W2, teclId: 9103, anchorTime: 400, text: '动生电动势能量来自外力做功，洛伦兹力总功为零——最常混的点。例题套路：B 分布→Φ→dΦ/dt，方向交给楞次。', createdAt: tsDaysAgo(now, 17, 12, 4), updatedAt: tsDaysAgo(now, 17, 12, 4) },
    { id: 'demo-note-7', courId: LA_W1, teclId: 9105, anchorTime: 320, text: '交换律反例必考：AB≠BA，「先 A 后 B」和「先 B 后 A」主对角线不一样。', createdAt: tsDaysAgo(now, 130, 12, 10), updatedAt: tsDaysAgo(now, 130, 12, 10) },
    { id: 'demo-note-8', courId: LA_W1, teclId: 9105, anchorTime: 625, text: '二阶逆矩阵口诀：主对角交换、副对角变号、除以行列式。特征方程 |A−λE|=0 下节展开讲对角化。', createdAt: tsDaysAgo(now, 130, 12, 22), updatedAt: tsDaysAgo(now, 130, 12, 22) },
  ];

  const externalNotes: ExternalNoteEntity[] = [
    { id: 'demo-xnote-1', mediaKey: BILI_MAIN_KEY, anchorTime: 58, text: '特征方程 |A − λE| = 0 先展开因式分解，二阶矩阵 λ₁=2, λ₂=3 代回各自方程求基础解系。', createdAt: tsDaysAgo(now, 4, 22, 1), updatedAt: tsDaysAgo(now, 4, 22, 1) },
    { id: 'demo-xnote-2', mediaKey: BILI_MAIN_KEY, anchorTime: 112, text: '实对称矩阵：不同特征值特征向量自动正交 → 重根子空间施密特正交化并单位化后拼 Q，QᵀAQ = Λ。', createdAt: tsDaysAgo(now, 4, 22, 4), updatedAt: tsDaysAgo(now, 4, 22, 4) },
    { id: 'demo-xnote-3', mediaKey: BILI_MAIN_KEY, anchorTime: 172, text: 'UP 主提醒：特征值解完务必回代验算 Av=λv，且 Q 列向量与 Λ 对角元次序必须一一对应。', createdAt: tsDaysAgo(now, 4, 22, 10), updatedAt: tsDaysAgo(now, 4, 22, 10) },
  ];

  // ── 截图元数据（blob 由 seed.ts 生成） ──
  const screenshotMetas: DemoScreenshotMeta[] = [
    { id: 'demo-shot-1', courId: DS_W1, view: 2, thumbDataUrl: '', meta: { courseName: '数据结构与算法', courLabel: '第10周 · 二叉树与BST', anchorTime: 960, watermark: true }, createdAt: tsDaysAgo(now, 1, 20, 12) },
    { id: 'demo-shot-2', courId: DS_W1, view: 2, thumbDataUrl: '', meta: { courseName: '数据结构与算法', courLabel: '第10周 · 中序后继图示', anchorTime: 1225, watermark: true }, createdAt: tsDaysAgo(now, 1, 20, 38) },
    { id: 'demo-shot-3', courId: MATH_W1, view: 1, thumbDataUrl: '', meta: { courseName: '高等数学（下）', courLabel: '第10周 · 莱布尼茨判别法板书', anchorTime: 1180, watermark: true }, createdAt: tsDaysAgo(now, 2, 19, 55) },
    { id: 'demo-shot-4', courId: PHYS_W2, view: 1, thumbDataUrl: '', meta: { courseName: '大学物理Ⅱ', courLabel: '第8周 · 楞次定律演示', anchorTime: 520, watermark: true }, createdAt: tsDaysAgo(now, 17, 11, 12) },
  ];

  // ── 收藏（6 类型全覆盖） ──
  const F_DS = 'demo-folder-9102';
  const F_MATH = 'demo-folder-9101';
  const F_PHYS = 'demo-folder-9103';
  const F_ENG = 'demo-folder-9104';
  const F_LA = 'demo-folder-9105';
  const fav = (id: string, row: Omit<FavoriteEntity, 'id' | 'updatedAt'>): FavoriteEntity => ({
    id,
    ...row,
    updatedAt: row.favoritedAt,
  });

  const favorites: FavoriteEntity[] = [
    fav('demo-fav-01', {
      type: 'time', refId: `${hduMediaKey(DS_W1)}@960`,
      snapshot: { title: '数据结构与算法 · 中序遍历的非递归实现', content: '一路向左入栈，弹出即访问，再转向右子树——与先序「入栈前访问」对照记忆。' },
      teclId: 9102, courId: DS_W1, anchorTime: 960, folderId: F_DS, tags: ['重点', '面试'], note: '面试手写高频，弹栈时机别写反', pinned: true,
      favoritedAt: tsDaysAgo(now, 1, 20, 18), metadata: { platform: 'hdu', courId: DS_W1, teclId: 9102, mediaKey: hduMediaKey(DS_W1) },
    }),
    fav('demo-fav-02', {
      type: 'time', refId: `${hduMediaKey(DS_W1)}@1148`,
      snapshot: { title: '数据结构与算法 · BST 删除：中序后继替换', content: '双子节点删除找右子树一路向左的最小节点，替换后有序性保持。' },
      teclId: 9102, courId: DS_W1, anchorTime: 1148, folderId: F_DS, tags: ['考点', '易错'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 1, 20, 52), metadata: { platform: 'hdu', courId: DS_W1, teclId: 9102, mediaKey: hduMediaKey(DS_W1) },
    }),
    fav('demo-fav-03', {
      type: 'ai', refId: 'demo-group-ds-1',
      snapshot: { title: '中序遍历什么时候入栈、什么时候访问？', content: '一路向左入栈，弹出即访问，再转向右子树；对比先序「入栈前访问」。' },
      teclId: 9102, courId: DS_W1, anchorTime: 520, folderId: F_DS, tags: ['案例'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 1, 20, 8), metadata: { platform: 'hdu', courId: DS_W1, teclId: 9102, mediaKey: hduMediaKey(DS_W1), question: '中序遍历什么时候入栈、什么时候访问？' },
    }),
    fav('demo-fav-04', {
      type: 'outline', refId: `${hduMediaKey(DS_W1)}@outline:900`,
      snapshot: { title: '数据结构与算法 · 大纲「二叉搜索树」', content: '定义、查找与插入（14:00–17:45）。' },
      teclId: 9102, courId: DS_W1, anchorTime: 900, folderId: F_DS, tags: ['重点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 1, 21, 30), metadata: { platform: 'hdu', courId: DS_W1, teclId: 9102, mediaKey: hduMediaKey(DS_W1) },
    }),
    fav('demo-fav-05', {
      type: 'screenshot', refId: 'demo-shot-1',
      snapshot: { title: '数据结构与算法 · 第10周 · 二叉树与BST', content: '课堂板书截图（14:20）。' },
      teclId: 9102, courId: DS_W1, anchorTime: 960, folderId: F_DS, tags: ['重点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 1, 20, 13), metadata: { platform: 'hdu', courId: DS_W1, screenshotId: 'demo-shot-1' },
    }),
    fav('demo-fav-06', {
      type: 'note', refId: 'demo-note-1',
      snapshot: { title: '我的笔记 · 数据结构与算法', content: 'BST 删除双子节点：右子树一路向左找中序后继，值抄过来再删后继。' },
      teclId: 9102, courId: DS_W1, anchorTime: 900, folderId: F_DS, tags: ['考点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 1, 21, 6), metadata: { platform: 'hdu', courId: DS_W1, teclId: 9102, noteId: 'demo-note-1' },
    }),
    fav('demo-fav-07', {
      type: 'time', refId: `${hduMediaKey(MATH_W1)}@390`,
      snapshot: { title: '高等数学（下） · 比值判别法适用条件', content: '后项比前项极限 <1 收敛，>1 发散，=1 失效换根值或比较判别法。' },
      teclId: 9101, courId: MATH_W1, anchorTime: 390, folderId: F_MATH, tags: ['考点'], note: 'ρ=1 时失效是判断题陷阱', pinned: true,
      favoritedAt: tsDaysAgo(now, 9, 20, 40), metadata: { platform: 'hdu', courId: MATH_W1, teclId: 9101, mediaKey: hduMediaKey(MATH_W1) },
    }),
    fav('demo-fav-08', {
      type: 'time', refId: `${hduMediaKey(MATH_W1)}@690`,
      snapshot: { title: '高等数学（下） · 交错级数与莱布尼茨判别法', content: '通项单调递减且趋于零则收敛；绝对收敛 vs 条件收敛的完整判别流程。' },
      teclId: 9101, courId: MATH_W1, anchorTime: 690, folderId: F_MATH, tags: ['重点', '考点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 2, 20, 40), metadata: { platform: 'hdu', courId: MATH_W1, teclId: 9101, mediaKey: hduMediaKey(MATH_W1) },
    }),
    fav('demo-fav-09', {
      type: 'ai', refId: 'demo-group-math-1',
      snapshot: { title: '条件收敛和绝对收敛到底差在哪？', content: '绝对收敛重排不改变和；条件收敛可重排出任何预设的和（黎曼定理）。' },
      teclId: 9101, courId: MATH_W1, anchorTime: 690, folderId: F_MATH, tags: [], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 2, 20, 34), metadata: { platform: 'hdu', courId: MATH_W1, teclId: 9101, mediaKey: hduMediaKey(MATH_W1), question: '条件收敛和绝对收敛到底差在哪？' },
    }),
    fav('demo-fav-10', {
      type: 'time', refId: `${hduMediaKey(PHYS_W2)}@188`,
      snapshot: { title: '大学物理Ⅱ · 法拉第定律与楞次定律', content: '感应电动势等于磁通量对时间变化率的负值；负号即楞次定律，能量守恒的表现。' },
      teclId: 9103, courId: PHYS_W2, anchorTime: 188, folderId: F_PHYS, tags: ['考点'], note: '期末重点', pinned: false,
      favoritedAt: tsDaysAgo(now, 17, 11, 26), metadata: { platform: 'hdu', courId: PHYS_W2, teclId: 9103, mediaKey: hduMediaKey(PHYS_W2) },
    }),
    fav('demo-fav-11', {
      type: 'time', refId: `${hduMediaKey(LA_W1)}@235`,
      snapshot: { title: '线性代数 · 交换律反例', content: '矩阵乘法不满足交换律：二阶反例 AB ≠ BA。' },
      teclId: 9105, courId: LA_W1, anchorTime: 235, folderId: F_LA, tags: ['易错'], note: '上学期归档', pinned: false,
      favoritedAt: tsDaysAgo(now, 140, 11, 40), metadata: { platform: 'hdu', courId: LA_W1, teclId: 9105, mediaKey: hduMediaKey(LA_W1) },
    }),
    fav('demo-fav-12', {
      type: 'ai', refId: 'demo-group-bili-1',
      snapshot: { title: '实对称矩阵为什么一定可以对角化？', content: '不同特征值的特征向量自动正交，重根可补齐 n 个无关向量。' },
      anchorTime: 84, folderId: F_LA, tags: ['网课', '考点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 4, 21, 55), metadata: { platform: 'bilibili', bvid: BILI_BVID_MAIN, url: `https://www.bilibili.com/video/${BILI_BVID_MAIN}`, mediaKey: BILI_MAIN_KEY, videoTitle: '线性代数公开课：特征值与相似对角化', question: '实对称矩阵为什么一定可以对角化？' },
    }),
    fav('demo-fav-13', {
      type: 'video', refId: BILI_BVID_MAIN,
      snapshot: { title: '线性代数公开课：特征值与相似对角化', content: 'B 站收藏的网课视频。' },
      folderId: F_LA, tags: ['网课'], note: '已刷完，讲义在置顶评论', pinned: false,
      favoritedAt: tsDaysAgo(now, 4, 21, 50), metadata: { platform: 'bilibili', bvid: BILI_BVID_MAIN, url: `https://www.bilibili.com/video/${BILI_BVID_MAIN}`, uploader: '线性代数小课堂', durationSec: 980, watchedRatio: 1, lastPositionSec: 950, coverUrl: '' },
    }),
    fav('demo-fav-14', {
      type: 'video', refId: BILI_BVID_DS,
      snapshot: { title: '数据结构 30 题精讲：二叉树与哈希', content: 'B 站收藏的刷题向网课。' },
      folderId: F_DS, tags: ['网课', '面试'], note: '看到哈希冲突部分', pinned: false,
      favoritedAt: tsDaysAgo(now, 6, 22, 12), metadata: { platform: 'bilibili', bvid: BILI_BVID_DS, url: `https://www.bilibili.com/video/${BILI_BVID_DS}`, uploader: '算法手写板', durationSec: 2450, watchedRatio: 0.45, lastPositionSec: 1100, coverUrl: '' },
    }),
    fav('demo-fav-15', {
      type: 'video', refId: BILI_BVID_PHYS,
      snapshot: { title: '大学物理期末速通：电磁学', content: 'B 站收藏的期末速通课。' },
      folderId: F_PHYS, tags: ['网课', '考点'], note: '考前二刷', pinned: false,
      favoritedAt: tsDaysAgo(now, 5, 19, 8), metadata: { platform: 'bilibili', bvid: BILI_BVID_PHYS, url: `https://www.bilibili.com/video/${BILI_BVID_PHYS}`, uploader: '物理速通社', durationSec: 1800, watchedRatio: 0.97, lastPositionSec: 1750, coverUrl: '' },
    }),
    fav('demo-fav-16', {
      type: 'screenshot', refId: 'demo-shot-3',
      snapshot: { title: '高等数学（下） · 第10周 · 莱布尼茨判别法板书', content: '板书截图（19:55）。' },
      teclId: 9101, courId: MATH_W1, anchorTime: 1180, folderId: F_MATH, tags: ['重点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 2, 19, 56), metadata: { platform: 'hdu', courId: MATH_W1, screenshotId: 'demo-shot-3' },
    }),
    fav('demo-fav-17', {
      type: 'outline', refId: `${hduMediaKey(LA_W1)}@outline:780`,
      snapshot: { title: '线性代数 · 大纲「特征值初步」', content: '特征方程与几何直观（13:00–18:25）。' },
      teclId: 9105, courId: LA_W1, anchorTime: 780, folderId: F_LA, tags: ['考点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 130, 12, 2), metadata: { platform: 'hdu', courId: LA_W1, teclId: 9105, mediaKey: hduMediaKey(LA_W1) },
    }),
    fav('demo-fav-18', {
      type: 'time', refId: `${hduMediaKey(PHYS_W2)}@858`,
      snapshot: { title: '大学物理Ⅱ · 自感与互感', content: '长直螺线管 L = μ n² V；互感系数互易性 M12 = M21；磁能 ½LI²。' },
      teclId: 9103, courId: PHYS_W2, anchorTime: 858, folderId: F_PHYS, tags: ['易错', '考点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 17, 11, 44), metadata: { platform: 'hdu', courId: PHYS_W2, teclId: 9103, mediaKey: hduMediaKey(PHYS_W2) },
    }),
    fav('demo-fav-19', {
      type: 'note', refId: 'demo-note-6',
      snapshot: { title: '我的笔记 · 大学物理Ⅱ', content: '动生电动势能量来自外力做功，洛伦兹力总功为零。' },
      teclId: 9103, courId: PHYS_W2, anchorTime: 400, folderId: F_PHYS, tags: ['考点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 16, 9, 2), metadata: { platform: 'hdu', courId: PHYS_W2, teclId: 9103, noteId: 'demo-note-6' },
    }),
    fav('demo-fav-20', {
      type: 'screenshot', refId: 'demo-shot-4',
      snapshot: { title: '大学物理Ⅱ · 第8周 · 楞次定律演示', content: '演示实验截图（11:12）。' },
      teclId: 9103, courId: PHYS_W2, anchorTime: 520, folderId: F_PHYS, tags: [], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 17, 11, 13), metadata: { platform: 'hdu', courId: PHYS_W2, screenshotId: 'demo-shot-4' },
    }),
    fav('demo-fav-21', {
      type: 'time', refId: `${hduMediaKey(1227073)}@600`,
      snapshot: { title: '大学英语（视听） · Lecture catch-up: note-taking', content: '听力要点：信号词 however / therefore 之后通常是考点。' },
      teclId: 9104, courId: 1227073, anchorTime: 600, folderId: F_ENG, tags: ['重点'], note: '', pinned: false,
      favoritedAt: tsDaysAgo(now, 12, 9, 20), metadata: { platform: 'hdu', courId: 1227073, teclId: 9104, mediaKey: hduMediaKey(1227073) },
    }),
  ];

  // ── 复习作业（三模板 × 逾期/今天/未来 + 已完成 + 已跳过） ──
  type JobSeed = Array<{
    id: string; favoriteId: string; due: number; round: number;
    template: ReviewJobEntity['template']; status: ReviewJobEntity['status'];
  }>;
  const jobSeeds: JobSeed = [
    // 待完成：逾期 3（-2/-1/-1）
    { id: 'demo-job-p01', favoriteId: 'demo-fav-07', due: -1, round: 2, template: 'regular', status: 'pending' },
    { id: 'demo-job-p02', favoriteId: 'demo-fav-10', due: -1, round: 1, template: 'exam', status: 'pending' },
    { id: 'demo-job-p03', favoriteId: 'demo-fav-05', due: -2, round: 1, template: 'regular', status: 'pending' },
    // 待完成：今天 4
    { id: 'demo-job-p04', favoriteId: 'demo-fav-01', due: 0, round: 1, template: 'regular', status: 'pending' },
    { id: 'demo-job-p05', favoriteId: 'demo-fav-02', due: 0, round: 3, template: 'regular', status: 'pending' },
    { id: 'demo-job-p06', favoriteId: 'demo-fav-08', due: 0, round: 1, template: 'regular', status: 'pending' },
    { id: 'demo-job-p07', favoriteId: 'demo-fav-09', due: 0, round: 1, template: 'custom', status: 'pending' },
    // 待完成：未来 7（+1..+5）
    { id: 'demo-job-p08', favoriteId: 'demo-fav-03', due: 1, round: 1, template: 'regular', status: 'pending' },
    { id: 'demo-job-p09', favoriteId: 'demo-fav-15', due: 1, round: 1, template: 'exam', status: 'pending' },
    { id: 'demo-job-p10', favoriteId: 'demo-fav-10', due: 2, round: 2, template: 'exam', status: 'pending' },
    { id: 'demo-job-p11', favoriteId: 'demo-fav-18', due: 2, round: 2, template: 'exam', status: 'pending' },
    { id: 'demo-job-p12', favoriteId: 'demo-fav-11', due: 3, round: 3, template: 'custom', status: 'pending' },
    { id: 'demo-job-p13', favoriteId: 'demo-fav-12', due: 4, round: 1, template: 'regular', status: 'pending' },
    { id: 'demo-job-p14', favoriteId: 'demo-fav-17', due: 5, round: 1, template: 'regular', status: 'pending' },
    // 已完成 8（过去 2..14 天）
    { id: 'demo-job-d01', favoriteId: 'demo-fav-02', due: -5, round: 2, template: 'regular', status: 'done' },
    { id: 'demo-job-d02', favoriteId: 'demo-fav-02', due: -12, round: 1, template: 'regular', status: 'done' },
    { id: 'demo-job-d03', favoriteId: 'demo-fav-07', due: -9, round: 1, template: 'regular', status: 'done' },
    { id: 'demo-job-d04', favoriteId: 'demo-fav-11', due: -7, round: 2, template: 'custom', status: 'done' },
    { id: 'demo-job-d05', favoriteId: 'demo-fav-11', due: -14, round: 1, template: 'custom', status: 'done' },
    { id: 'demo-job-d06', favoriteId: 'demo-fav-18', due: -3, round: 1, template: 'exam', status: 'done' },
    { id: 'demo-job-d07', favoriteId: 'demo-fav-13', due: -2, round: 1, template: 'regular', status: 'done' },
    { id: 'demo-job-d08', favoriteId: 'demo-fav-01', due: -8, round: 1, template: 'regular', status: 'done' },
    // 已跳过 2
    { id: 'demo-job-s01', favoriteId: 'demo-fav-19', due: -2, round: 1, template: 'regular', status: 'skipped' },
    { id: 'demo-job-s02', favoriteId: 'demo-fav-14', due: -1, round: 1, template: 'regular', status: 'skipped' },
  ];
  const reviewJobs: ReviewJobEntity[] = jobSeeds.map((j) => ({
    id: j.id,
    favoriteId: j.favoriteId,
    dueDate: dayKeyAgo(now, -j.due), // due 为负 = 过去
    round: j.round,
    template: j.template,
    status: j.status,
    createdAt: tsDaysAgo(now, Math.max(0, 14 - j.due), 12),
    updatedAt: tsDaysAgo(now, Math.max(0, 1 - j.due), 12),
  }));

  // ── 站内学习流水（90 天：工作日晚间为主、周末轻、偶尔中断；近 14 天全勤保连续） ──
  const rng = mulberry32(3190319);
  const watchRecords: WatchRecordEntity[] = [];
  let recordId = 1;
  const watchCourIds = [DS_W1, 1227053, 1227042, MATH_W1, 1227062, PHYS_W2, 1227072, LA_W1];
  for (let d = 89; d >= 0; d -= 1) {
    const dateTs = now - d * DAY_MS;
    const weekday = new Date(dateTs).getDay(); // 0=周日
    const isWeekend = weekday === 0 || weekday === 6;
    // 近 14 天全勤（连续天数演示）；更早的日子约 30% 缺勤（期中/生病等）
    const forced = d <= 13;
    if (!forced && rng() < 0.3) continue;
    const isToday = d === 0;
    const morning = !isToday && rng() < 0.18;
    const hour = isToday ? 12 : morning ? 8 : isWeekend ? 15 : 19;
    const minute = isToday ? 30 : Math.floor(rng() * 50);
    // 今日流水从「now 往回 20–40 分钟」起算：绝对时刻（如 12:30）在任意运行时刻都可能在
    // 未来，改为相对锚点保证 start/end 恒不越过 now
    const start = isToday
      ? now - Math.round((20 + rng() * 20) * 60_000)
      : tsDaysAgo(now, d, hour, minute);
    const sec = Math.round(
      (isWeekend ? 1200 + rng() * 1800 : morning ? 1500 + rng() * 1200 : 2400 + rng() * 3000) / 60,
    ) * 60;
    // 结束时刻不越过现在：越界则收到 now 前 30s；剩余不足 1 分钟的槽位跳过
    let durationSec = sec;
    if (start + durationSec * 1000 > now) {
      durationSec = Math.floor((now - start) / 1000) - 30;
      if (durationSec < 60) continue;
    }
    const end = start + durationSec * 1000;
    const courId = watchCourIds[(d + Math.floor(rng() * 3)) % watchCourIds.length] ?? DS_W1;
    watchRecords.push({
      id: recordId++,
      courId,
      teclId: 9101 + ((d + Math.floor(rng() * 4)) % 4),
      date: dayKeyAgo(now, d),
      startTs: start,
      endTs: end,
      durationSec,
      playMode: 'vod',
      speed: 1,
      firstWatch: rng() < 0.7,
      // 老日子里偶尔留一条挂机审计行（不进报表）
      valid: d > 30 && rng() < 0.04 ? false : true,
    });
    // 部分晚上再补一段睡前复习（近几天更多，时段分布更立体）
    if (!isToday && d <= 10 && rng() < 0.55) {
      const sec2 = Math.round((900 + rng() * 1500) / 60) * 60;
      const start2 = tsDaysAgo(now, d, 22, 20);
      if (start2 + sec2 * 1000 <= now) {
        watchRecords.push({
          id: recordId++,
          courId: watchCourIds[(d + 2) % watchCourIds.length] ?? MATH_W1,
          teclId: 9101,
          date: dayKeyAgo(now, d),
          startTs: start2,
          endTs: start2 + sec2 * 1000,
          durationSec: sec2,
          playMode: 'vod',
          speed: 1,
          firstWatch: false,
          valid: true,
        });
      }
    }
  }

  // ── B 站站外学习线 ──
  const externalWatch: ExternalWatchEntity[] = [];
  const biliPlan: Array<{ day: number; bvid: string; sec: number }> = [
    { day: 0, bvid: BILI_BVID_PHYS, sec: 1560 },
    { day: 1, bvid: BILI_BVID_MAIN, sec: 1080 },
    { day: 2, bvid: BILI_BVID_PHYS, sec: 900 },
    { day: 3, bvid: BILI_BVID_MAIN, sec: 1440 },
    { day: 4, bvid: BILI_BVID_MAIN, sec: 720 },
    { day: 6, bvid: BILI_BVID_DS, sec: 1980 },
    { day: 8, bvid: BILI_BVID_DS, sec: 1500 },
    { day: 9, bvid: BILI_BVID_DS, sec: 1080 },
    { day: 12, bvid: BILI_BVID_MAIN, sec: 1260 },
    { day: 15, bvid: BILI_BVID_DS, sec: 1620 },
    { day: 19, bvid: BILI_BVID_MAIN, sec: 840 },
    { day: 24, bvid: BILI_BVID_PHYS, sec: 1380 },
    { day: 30, bvid: BILI_BVID_DS, sec: 1140 },
  ];
  const biliTitles: Record<string, string> = {
    [BILI_BVID_MAIN]: '线性代数公开课：特征值与相似对角化',
    [BILI_BVID_DS]: '数据结构 30 题精讲：二叉树与哈希',
    [BILI_BVID_PHYS]: '大学物理期末速通：电磁学',
  };
  for (const row of biliPlan) {
    externalWatch.push({
      id: `${dayKeyAgo(now, row.day)}:${row.bvid}`,
      date: dayKeyAgo(now, row.day),
      bvid: row.bvid,
      title: biliTitles[row.bvid],
      seconds: row.sec,
    });
  }

  const videoProgress: VideoProgressEntity[] = [
    { id: `bilibili:${BILI_BVID_MAIN}`, platform: 'bilibili', videoId: BILI_BVID_MAIN, title: biliTitles[BILI_BVID_MAIN], durationSec: 980, lastPositionSec: 950, updatedAt: tsDaysAgo(now, 1, 22, 30) },
    { id: `bilibili:${BILI_BVID_DS}`, platform: 'bilibili', videoId: BILI_BVID_DS, title: biliTitles[BILI_BVID_DS], durationSec: 2450, lastPositionSec: 1100, updatedAt: tsDaysAgo(now, 6, 23, 10) },
    { id: `bilibili:${BILI_BVID_PHYS}`, platform: 'bilibili', videoId: BILI_BVID_PHYS, title: biliTitles[BILI_BVID_PHYS], durationSec: 1800, lastPositionSec: 1750, updatedAt: tsDaysAgo(now, 0, 13, 5) },
  ];

  // 进行中的每周回看计划（部分看完 → 完成度可演示）
  const weeklyPlans: WeeklyPlan[] = [
    {
      id: 'demo-weekly-1',
      label: '线代 + 数据结构刷题计划（B 站收藏夹）',
      perDay: 2,
      bvids: [BILI_BVID_MAIN, BILI_BVID_PHYS, BILI_BVID_DS, BILI_BVID_MAIN, BILI_BVID_PHYS],
      startDate: dayKeyAgo(now, 3),
      createdAt: tsDaysAgo(now, 3, 9, 30),
      updatedAt: tsDaysAgo(now, 1, 21, 40),
    },
  ];

  // ── 课表（本周：四门本学期课的正常时段） ──
  const curriculum: CurriculumItem[] = COURSES.filter((c) => c.semester === '2026-2027-1').map((c) => {
    const begin = tsInWeek(monday, 0, c.weekday, c.hour, c.minute);
    return {
      courId: c.courIdBase,
      teclId: c.teclId,
      subjName: c.subjName,
      beginTime: begin,
      endTime: begin + c.durationSec * 1000,
      clroName: c.clroName,
      letiNumber: c.weekNumberNow,
      status: begin < now ? '已结束' : '待上课',
    };
  });

  // ── KV（termYear 与播种标记之外的内部状态） ──
  const kv: Array<{ key: string; value: unknown }> = [
    { key: 'schedule:termYear', value: { acteId: 9, name: '2026-2027-1', currentTerm: true } },
  ];

  return {
    courses,
    sessions,
    transcripts,
    aiResults,
    chats,
    favorites,
    folders,
    tags,
    notes,
    externalNotes,
    screenshotMetas,
    watchRecords,
    reviewJobs,
    curriculum,
    videoProgress,
    externalWatch,
    weeklyPlans,
    kv,
  };
}
