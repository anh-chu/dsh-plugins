/**
 * The module list. Order is irrelevant; the registry sorts by seam and refuses
 * to start two enabled exclusive owners whose targets intersect.
 *
 * Each module file default-exports a descriptor matching docs/CONTRACT.md.
 */
import admitOutput from './admit-output.js';
import screenFetch from './screen-fetch.js';
import selectSkill from './select-skill.js';
import gateCompletion from './gate-completion.js';
import toolsAsk from './tools-ask.js';
import admitTerminal from './admit-terminal.js';
import superviseGoal from './supervise-goal.js';
import remindDrift from './remind-drift.js';
import guideInstructions from './guide-instructions.js';
import answerQuestions from './answer-questions.js';
import nagNoGoal from './nag-nogoal.js';
import notifyDecline from './notify-decline.js';
import toolsSurface from './tools-surface.js';
import rankFiles from './rank-files.js';
import routeInterjection from './route-interjection.js';
import approveWorkspace from './approve-workspace.js';
import guideShared from './guide-shared.js';

export default [
  admitOutput,
  screenFetch,
  selectSkill,
  gateCompletion,
  toolsAsk,
  admitTerminal,
  superviseGoal,
  remindDrift,
  guideInstructions,
  answerQuestions,
  nagNoGoal,
  notifyDecline,
  toolsSurface,
  rankFiles,
  routeInterjection,
  approveWorkspace,
  guideShared,
];
