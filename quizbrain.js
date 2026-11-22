/* erekengo — встроенный решатель тестов (без API).
 * created by Yernat Bakytnur */
(() => {
  'use strict';

  const norm = (s) => (s || '').toLowerCase()
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d«»]/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  const includes = (a, b) => {
    const x = norm(a), y = norm(b);
    return !!x && !!y && (x === y || (x.length >= 9 && y.startsWith(x)) ||
      (y.length >= 9 && x.startsWith(y)) || (x.length >= 14 && y.includes(x)));
  };

  // Точные ответы по курсу «Introduction to Git and GitHub».
  const KEY = {
    fNLY7: { radio: ['patch fix_names.conf < fix_names.patch', 'diff fix_permissions.py fix_permissions_modified.py > fix_permissions.diff', 'wdiff', 'Using the exit command from the sys module', 'Diff file'] },
    '2kyMm': { radio: ['Linus Torvalds', 'Version control', 'commit', 'repositories'], check: [
      'Git retains local copies of repositories, resulting in fast operations.',
      'If something breaks due to a change, you can fix the problem by reverting to a working version before the change.',
      'Git allows you to review the history of your project.'
    ]},
    '1XxjS': { radio: ['git add', 'git log', 'git add', 'git config -l', 'git status'] },
    zfvVZ: { radio: ['git mv', 'A file containing a list of files or filename patterns for Git to skip for the current repo.', 'New files', 'The currently checked-out snapshot of your project', '--stat'] },
    C5rDX: { radio: ['git revert', 'use the commit ID at the end of the git revert command', 'To identify commits', 'Overwrite the previous commit', 'git show'] },
    wjd2M: { radio: ['three-way merge', 'git merge --abort', 'git log --graph --oneline'] },
    YDLD3: { radio: ['git pull', 'Allowing automated login to GitHub', 'git clone <URL>'], check: ['Use a credential helper', 'Create an SSH key-pair'] },
    AcApM: { radio: ['git remote update', 'git remote show origin', 'git fetch', 'Explicit merge', 'git pull'] },
    Nw4YS: { radio: ['git pull', 'When you want to keep a linear commit history', 'The master branch', 'git rebase <branchname>'], check: [
      'When working on a big change, it makes sense to have a separate feature branch.',
      'Always synchronize your branches before starting any work on your own.',
      'Avoid having very large changes that modify a lot of different things.'
    ]},
    er2Cv: { radio: ['Squash combines the commit messages into one. Fixup discards the new commit message.', 'A request sent to the owner and collaborators of the target repository to pull your recent changes.', 'When you want to experiment with changes without affecting the main repository.', 'git push -f', 'pick'] },
    hqplM: { radio: ['Always', 'A trivial comment or suggestion', 'Outdated'], check: [
      'Using unclear names', 'Forgetting to handle a specific condition', 'Forgetting to add tests',
      'Make sure that the contents are easy to understand', 'Ensure consistent style', "Ensure we don't forget any important cases"
    ]},
    eHDW1: { radio: ['By using one of the keywords followed by a hashtag and the issue number.', 'Any file generated as part of the CI/CD pipeline.', 'Run tests automatically', 'Update with incremental rollouts'], check: [
      'Reply promptly to pull-requests', 'Understand any changes you accept', 'Use an issue tracker'
    ]},
    yMlKa: { radio: ['A version control system', 'Initialize a new repository using git init', 'git status', 'Saves the staged changes to the local repository', 'A text file named README', 'Under “Changes to be committed”', 'Where files are gathered and prepared for Git before committing them', 'git commit -m "Revisions complete"', 'git log'], check: [
      'It stores the current contents of the index in a new commit along with the commit message.',
      "A snapshot is captured of the project's currently staged changes.",
      'It changes the status of the repository.'
    ]},
    VI1SF: { radio: ['A Git repository is a version control system that tracks changes to source code, allowing multiple developers to collaborate, review changes, and maintain a complete history of project revisions.', 'git log', 'git diff > changes.patch', 'git push', 'git branch', 'git merge', "Git can't automatically merge the changes and needs your help to resolve the conflict.", 'To work on a new feature or bug fix without disrupting the main code', 'Whether the changes are significant or experimental'], check: [
      'Conflicts may occur during merging.', 'Merged changes can be undone using the git revert command.'
    ]},
    mVyLY: { radio: ['Choosing private means no one but you can see or commit to the repository.', 'In the Developer settings of your Github account', 'Adds content from the working directory into the staging area for the next commit', 'git clone server/project', 'A log message from the user describing the changes', 'There are no specific requirements for a commit message.', 'git pull origin main', 'Pull the current snapshot/commit in the remote repository to the local repository, update the local repository from the remote repository, then push the changes from the local repository to the remote one.', 'git push origin main'], check: [
      'Choosing a password', 'Choosing a username', 'Providing a valid email address'
    ]},
    J2xwD: { radio: ['To ensure that no one is currently working on the same files', 'git status', 'Include a detailed description of the changes', 'It remains available for further work.', 'Push the changes to your branch and they will automatically update the pull request', 'To check the code for errors or bugs', 'The clarity and readability of the code', 'The pull request has been merged into the base branch', 'A duplicate of the original repository is created in your GitHub account.'], check: [
      "Propose changes to someone else's code", 'Merge changes from another branch', 'Preview changes before merging them', 'Request reviews from your peers'
    ]}
  };

  const DOMAIN = [
    { q: /what is git|define git/i, a: /version control system/i },
    { q: /who (created|developed) git|creator of git/i, a: /linus torvalds/i },
    { q: /staging area|staged changes|index/i, a: /staging area|index|git add/i },
    { q: /see the status|check the status/i, a: /git status/i },
    { q: /view (the )?history|commit history|show commits/i, a: /git log/i },
    { q: /save (the )?changes|record changes|create a commit/i, a: /git commit/i },
    { q: /undo (the )?last commit|reverse a commit/i, a: /git revert/i },
    { q: /download|get a copy|clone/i, a: /git clone/i },
    { q: /fetch from|update from remote/i, a: /git fetch/i },
    { q: /combine branches|join branches|merge/i, a: /git merge/i },
    { q: /linear (commit )?history|rebase/i, a: /rebase/i },
    { q: /conflict/i, a: /needs your help|resolve the conflict|conflicts may occur/i },
    { q: /credential|login to github|authenticat/i, a: /credential helper|ssh key/i },
    { q: /pull request/i, a: /request sent to the owner|propose changes/i },
    { q: /ignore file|files to skip/i, a: /list of files or filename patterns to skip/i },
    { q: /rename.*file|move.*file/i, a: /git mv/i },
    { q: /private repo|only you can see/i, a: /no one but you can see/i },
    { q: /push/i, a: /git push/i },
    { q: /branch/i, a: /feature branch|git branch/i }
  ];

  const NEG = /\b(not|never|incorrect|wrong|false|except|isn't|aren't|doesn't|cannot|can't)\b/i;
  const POS = /\b(correct|true|right|allows|enables|ensures|stores|saves|used to|helps|can)\b/i;

  function scoreOption(qt, o) {
    const q = norm(qt), x = norm(o);
    let s = 0;
    const stop = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'what', 'which', 'when', 'how', 'why', 'you', 'your', 'git', 'github', 'does', 'do', 'be', 'this', 'that']);
    q.split(/\W+/).filter(w => w.length > 3 && !stop.has(w)).forEach(w => { if (x.includes(w)) s += 1.2; });
    DOMAIN.forEach(r => { if (r.q.test(q) && r.a.test(x)) s += 4; });
    if (POS.test(x)) s += 0.5;
    if (NEG.test(x)) s -= 1.5;
    s += Math.min(x.length / 120, 0.8);
    return s;
  }

  function decide({ itemId = '', questions = [] } = {}) {
    const selections = questions.map((q) => {
      const opts = q.options || [];
      const type = q.type || 'radio';
      let chosen = [];
      const key = KEY[itemId];
      if (key) {
        const pool = type === 'checkbox' ? (key.check || []) : (key.radio || []);
        pool.forEach(a => {
          const hit = opts.find(o => includes(a, o));
          if (hit && !chosen.includes(hit)) chosen.push(hit);
        });
      }
      if (!chosen.length) {
        const scored = opts.map(o => ({ o, s: scoreOption(q.text, o) })).sort((a, b) => b.s - a.s);
        if (type === 'checkbox') {
          const top = scored.filter(x => x.s > 2).slice(0, 4);
          chosen = (top.length ? top : scored.slice(0, 2)).map(x => x.o);
        } else if (scored.length) chosen = [scored[0].o];
      }
      return chosen;
    });
    const exact = Object.prototype.hasOwnProperty.call(KEY, itemId);
    return { selections, source: exact ? 'knowledge' : 'reasoning' };
  }

  window.__erekengoQuizBrain = { norm, includes, decide, KEY, DOMAIN };
})();
