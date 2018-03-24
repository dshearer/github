import fs from 'fs';
import path from 'path';

import React from 'react';
import {mount} from 'enzyme';

import dedent from 'dedent-js';
import until from 'test-until';

import GitTabController from '../../lib/controllers/git-tab-controller';

import {cloneRepository, buildRepository, buildRepositoryWithPipeline} from '../helpers';
import Repository from '../../lib/models/repository';
import {GitError} from '../../lib/git-shell-out-strategy';

import ResolutionProgress from '../../lib/models/conflicts/resolution-progress';

describe('GitTabController', function() {
  let atomEnvironment, workspace, workspaceElement, commandRegistry, notificationManager, config, tooltips;
  let resolutionProgress, refreshResolutionProgress;
  let app;

  beforeEach(function() {
    atomEnvironment = global.buildAtomEnvironment();
    workspace = atomEnvironment.workspace;
    commandRegistry = atomEnvironment.commands;
    notificationManager = atomEnvironment.notifications;
    config = atomEnvironment.config;
    tooltips = atomEnvironment.tooltips;

    workspaceElement = atomEnvironment.views.getView(workspace);

    resolutionProgress = new ResolutionProgress();
    refreshResolutionProgress = sinon.spy();

    const noop = () => {};

    app = (
      <GitTabController
        workspace={workspace}
        commandRegistry={commandRegistry}
        grammars={atomEnvironment.grammars}
        resolutionProgress={resolutionProgress}
        notificationManager={notificationManager}
        config={config}
        project={atomEnvironment.project}
        tooltips={tooltips}

        confirm={noop}
        ensureGitTab={noop}
        refreshResolutionProgress={refreshResolutionProgress}
        undoLastDiscard={noop}
        discardWorkDirChangesForPaths={noop}
        openFiles={noop}
        didSelectFilePath={noop}
        initializeRepo={noop}
      />
    );
  });

  afterEach(function() {
    atomEnvironment.destroy();
  });

  it('displays a loading message in GitTabView while data is being fetched', async function() {
    const workdirPath = await cloneRepository('three-files');
    fs.writeFileSync(path.join(workdirPath, 'a.txt'), 'a change\n');
    fs.unlinkSync(path.join(workdirPath, 'b.txt'));
    const repository = new Repository(workdirPath);
    assert.isTrue(repository.isLoading());

    app = React.cloneElement(app, {repository});
    const wrapper = mount(app);

    assert.isTrue(wrapper.hasClass('is-loading'));
    assert.lengthOf(wrapper.find('EtchWrapper'), 1);
    assert.lengthOf(wrapper.find('CommitController'), 1);

    await assert.async.isFalse(wrapper.hasClass('is-loading'));
    assert.lengthOf(wrapper.find('EtchWrapper'), 1);
    assert.lengthOf(wrapper.find('CommitController'), 1);
  });

  it('displays an initialization prompt for an absent repository', function() {
    const repository = Repository.absent();

    app = React.cloneElement(app, {repository});
    const wrapper = mount(app);

    assert.isTrue(wrapper.hasClass('is-empty'));
    assert.lengthOf(wrapper.find('.no-repository'), 1);
  });

  it('keeps the state of the GitTabView in sync with the assigned repository', async function() {
    const workdirPath1 = await cloneRepository('three-files');
    const repository1 = await buildRepository(workdirPath1);
    const workdirPath2 = await cloneRepository('three-files');
    const repository2 = await buildRepository(workdirPath2);

    fs.writeFileSync(path.join(workdirPath1, 'a.txt'), 'a change\n');
    fs.unlinkSync(path.join(workdirPath1, 'b.txt'));

    app = React.cloneElement(app, {repository: Repository.absent()});
    const wrapper = mount(app);

    // Renders empty GitTabView when there is no active repository

    assert.isTrue(wrapper.prop('repository').isAbsent());
    assert.lengthOf(wrapper.find('.no-repository'), 1);

    // Fetches data when a new repository is assigned
    // Does not update repository instance variable until that data is fetched
    wrapper.setProps({repository: repository1});
    await assert.async.deepEqual(wrapper.find('GitTabView').prop('unstagedChanges'), await repository1.getUnstagedChanges());

    wrapper.setProps({repository: repository2});
    await assert.async.deepEqual(wrapper.find('GitTabView').prop('unstagedChanges'), await repository2.getUnstagedChanges());

    // Fetches data and updates child view when the repository is mutated
    fs.writeFileSync(path.join(workdirPath2, 'a.txt'), 'a change\n');
    fs.unlinkSync(path.join(workdirPath2, 'b.txt'));
    repository2.refresh();

    await assert.async.deepEqual(wrapper.find('GitTabView').prop('unstagedChanges'), await repository2.getUnstagedChanges());
  });

  it('displays the staged changes since the parent commit when amending', async function() {
    const workdirPath = await cloneRepository('multiple-commits');
    const repository = await buildRepository(workdirPath);
    const ensureGitTab = () => Promise.resolve(false);

    app = React.cloneElement(app, {
      repository,
      ensureGitTab,
      isAmending: false,
    });
    const wrapper = mount(app);

    await assert.async.deepEqual(wrapper.find('GitTabView').prop('unstagedChanges'), []);

    await repository.setAmending(true);
    await assert.async.deepEqual(
      wrapper.find('GitTabView').prop('stagedChanges'),
      await repository.getStagedChangesSinceParentCommit(),
    );
  });

  it('fetches conflict marker counts for conflicting files', async function() {
    const workdirPath = await cloneRepository('merge-conflict');
    const repository = await buildRepository(workdirPath);
    await assert.isRejected(repository.git.merge('origin/branch'));

    const rp = new ResolutionProgress();
    rp.reportMarkerCount(path.join(workdirPath, 'added-to-both.txt'), 5);

    app = React.cloneElement(app, {
      repository,
      resolutionProgress: rp,
    });
    mount(app);

    await assert.async.isTrue(refreshResolutionProgress.calledWith(path.join(workdirPath, 'modified-on-both-ours.txt')));
    assert.isTrue(refreshResolutionProgress.calledWith(path.join(workdirPath, 'modified-on-both-theirs.txt')));
    assert.isFalse(refreshResolutionProgress.calledWith(path.join(workdirPath, 'added-to-both.txt')));
  });

  describe('abortMerge()', function() {
    it('resets merge related state', async function() {
      const workdirPath = await cloneRepository('merge-conflict');
      const repository = await buildRepository(workdirPath);

      await assert.isRejected(repository.git.merge('origin/branch'));

      const confirm = sinon.stub();
      app = React.cloneElement(app, {repository, confirm});
      const wrapper = mount(app);
      const view = wrapper.find('GitTabView');

      await assert.async.isTrue(view.prop('isMerging'));
      assert.notEqual(view.prop('mergeConflicts').length, 0);
      assert.isOk(view.prop('mergeMessage'));

      confirm.returns(0);
      await wrapper.instance().getWrappedComponentInstance().abortMerge();

      await assert.async.lengthOf(view.prop('mergeConflicts'), 0);
      assert.isFalse(view.prop('isMerging'));
      assert.isNull(view.prop('mergeMessage'));
    });
  });

  describe('prepareToCommit', function() {
    it('shows the git panel and returns false if it was hidden', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepository(workdirPath);

      const ensureGitTab = () => Promise.resolve(true);
      app = React.cloneElement(app, {repository, ensureGitTab});
      const wrapper = mount(app);

      assert.isFalse(await wrapper.instance().getWrappedComponentInstance().prepareToCommit());
    });

    it('returns true if the git panel was already visible', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepository(workdirPath);

      const ensureGitTab = () => Promise.resolve(false);
      app = React.cloneElement(app, {repository, ensureGitTab});
      const wrapper = mount(app);

      assert.isTrue(await wrapper.instance().getWrappedComponentInstance().prepareToCommit());
    });
  });

  describe('commit(message)', function() {
    it('shows an error notification when committing throws an error', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepositoryWithPipeline(workdirPath, {confirm, notificationManager, workspace});
      sinon.stub(repository.git, 'commit').callsFake(async () => {
        await Promise.resolve();
        throw new GitError('message');
      });

      app = React.cloneElement(app, {repository});
      const wrapper = mount(app);

      notificationManager.clear(); // clear out any notifications
      try {
        await wrapper.instance().getWrappedComponentInstance().commit();
      } catch (e) {
        assert(e, 'is error');
      }
      assert.equal(notificationManager.getNotifications().length, 1);
    });

    it('sets amending to false', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepositoryWithPipeline(workdirPath, {confirm, notificationManager, workspace});
      repository.setAmending(true);
      sinon.stub(repository.git, 'commit').callsFake(() => Promise.resolve());
      const didChangeAmending = sinon.stub();

      app = React.cloneElement(app, {repository, didChangeAmending});
      const wrapper = mount(app);

      assert.isTrue(repository.isAmending());
      await wrapper.instance().getWrappedComponentInstance().commit('message');
      assert.isFalse(repository.isAmending());
    });
  });

  it('selects an item by description', async function() {
    const workdirPath = await cloneRepository('three-files');
    const repository = await buildRepository(workdirPath);

    fs.writeFileSync(path.join(workdirPath, 'unstaged-1.txt'), 'This is an unstaged file.');
    fs.writeFileSync(path.join(workdirPath, 'unstaged-2.txt'), 'This is an unstaged file.');
    fs.writeFileSync(path.join(workdirPath, 'unstaged-3.txt'), 'This is an unstaged file.');
    repository.refresh();

    app = React.cloneElement(app, {repository});
    const wrapper = mount(app);

    await assert.async.lengthOf(wrapper.find('GitTabView').prop('unstagedChanges'), 3);

    const controller = wrapper.instance().getWrappedComponentInstance();
    const gitTab = controller.refView;
    const stagingView = gitTab.refStagingView.getWrappedComponent();

    sinon.spy(stagingView, 'setFocus');

    await controller.focusAndSelectStagingItem('unstaged-2.txt', 'unstaged');

    const selections = Array.from(stagingView.selection.getSelectedItems());
    assert.lengthOf(selections, 1);
    assert.equal(selections[0].filePath, 'unstaged-2.txt');

    assert.equal(stagingView.setFocus.callCount, 1);
  });

  describe('focus management', function() {
    it('does nothing on an absent repository', function() {
      const repository = Repository.absent();

      app = React.cloneElement(app, {repository});
      const wrapper = mount(app);
      const controller = wrapper.instance().getWrappedComponentInstance();

      assert.isTrue(wrapper.hasClass('is-empty'));
      assert.lengthOf(wrapper.find('.no-repository'), 1);

      controller.rememberLastFocus({target: null});
      assert.strictEqual(controller.lastFocus, GitTabController.focus.STAGING);
    });
  });

  describe('keyboard navigation commands', function() {
    let wrapper, gitTab, stagingView, commitView, commitController, focusElement;
    const focuses = GitTabController.focus;

    const extractReferences = () => {
      gitTab = wrapper.instance().getWrappedComponentInstance().refView;
      stagingView = gitTab.refStagingView.getWrappedComponent();
      commitController = gitTab.refCommitController;
      commitView = commitController.refCommitView;
      focusElement = stagingView.element;

      const stubFocus = element => {
        if (!element) {
          return;
        }
        sinon.stub(element, 'focus').callsFake(() => {
          focusElement = element;
        });
      };
      stubFocus(stagingView.element);
      stubFocus(commitView.editorElement);
      stubFocus(commitView.refAbortMergeButton);
      stubFocus(commitView.refAmendCheckbox);
      stubFocus(commitView.refCommitButton);

      sinon.stub(commitController, 'hasFocus').callsFake(() => {
        return [
          commitView.editorElement,
          commitView.refAbortMergeButton,
          commitView.refAmendCheckbox,
          commitView.refCommitButton,
        ].includes(focusElement);
      });
    };

    const assertSelected = paths => {
      const selectionPaths = Array.from(stagingView.selection.getSelectedItems()).map(item => item.filePath);
      assert.deepEqual(selectionPaths, paths);
    };

    describe('with conflicts and staged files', function() {
      beforeEach(async function() {
        const workdirPath = await cloneRepository('each-staging-group');
        const repository = await buildRepository(workdirPath);

        // Merge with conflicts
        assert.isRejected(repository.git.merge('origin/branch'));

        fs.writeFileSync(path.join(workdirPath, 'unstaged-1.txt'), 'This is an unstaged file.');
        fs.writeFileSync(path.join(workdirPath, 'unstaged-2.txt'), 'This is an unstaged file.');
        fs.writeFileSync(path.join(workdirPath, 'unstaged-3.txt'), 'This is an unstaged file.');

        // Three staged files
        fs.writeFileSync(path.join(workdirPath, 'staged-1.txt'), 'This is a file with some changes staged for commit.');
        fs.writeFileSync(path.join(workdirPath, 'staged-2.txt'), 'This is another file staged for commit.');
        fs.writeFileSync(path.join(workdirPath, 'staged-3.txt'), 'This is a third file staged for commit.');
        await repository.stageFiles(['staged-1.txt', 'staged-2.txt', 'staged-3.txt']);
        repository.refresh();

        const didChangeAmending = () => {};

        app = React.cloneElement(app, {repository, didChangeAmending});
        wrapper = mount(app);
        await assert.async.lengthOf(wrapper.find('GitTabView').prop('unstagedChanges'), 3);

        extractReferences();
      });

      it('blurs on tool-panel:unfocus', function() {
        sinon.spy(workspace.getActivePane(), 'activate');

        commandRegistry.dispatch(wrapper.find('.github-Panel').getNode(), 'tool-panel:unfocus');

        assert.isTrue(workspace.getActivePane().activate.called);
      });

      it('advances focus through StagingView groups and CommitView, but does not cycle', function() {
        assertSelected(['unstaged-1.txt']);

        commandRegistry.dispatch(gitTab.refRoot, 'core:focus-next');
        assertSelected(['conflict-1.txt']);

        commandRegistry.dispatch(gitTab.refRoot, 'core:focus-next');
        assertSelected(['staged-1.txt']);

        commandRegistry.dispatch(gitTab.refRoot, 'core:focus-next');
        assertSelected(['staged-1.txt']);
        assert.strictEqual(focusElement, commitView.editorElement);

        // This should be a no-op. (Actually, it'll insert a tab in the CommitView editor.)
        commandRegistry.dispatch(gitTab.refRoot, 'core:focus-next');
        assertSelected(['staged-1.txt']);
        assert.strictEqual(focusElement, commitView.editorElement);
      });

      it('retreats focus from the CommitView through StagingView groups, but does not cycle', function() {
        gitTab.setFocus(focuses.EDITOR);

        commandRegistry.dispatch(gitTab.refRoot, 'core:focus-previous');
        assertSelected(['staged-1.txt']);

        commandRegistry.dispatch(gitTab.refRoot, 'core:focus-previous');
        assertSelected(['conflict-1.txt']);

        commandRegistry.dispatch(gitTab.refRoot, 'core:focus-previous');
        assertSelected(['unstaged-1.txt']);

        // This should be a no-op.
        commandRegistry.dispatch(gitTab.refRoot, 'core:focus-previous');
        assertSelected(['unstaged-1.txt']);
      });
    });

    describe('with staged changes', function() {
      let repository;

      beforeEach(async function() {
        const workdirPath = await cloneRepository('each-staging-group');
        repository = await buildRepository(workdirPath);

        // A staged file
        fs.writeFileSync(path.join(workdirPath, 'staged-1.txt'), 'This is a file with some changes staged for commit.');
        await repository.stageFiles(['staged-1.txt']);
        repository.refresh();

        const didChangeAmending = () => {};
        const prepareToCommit = () => Promise.resolve(true);
        const ensureGitTab = () => Promise.resolve(false);

        app = React.cloneElement(app, {repository, ensureGitTab, prepareToCommit, didChangeAmending});
        wrapper = mount(app);

        extractReferences();
        await assert.async.isTrue(commitView.props.stagedChangesExist);
      });

      it('focuses the CommitView on github:commit with an empty commit message', async function() {
        commitView.editor.setText('');
        sinon.spy(wrapper.instance().getWrappedComponentInstance(), 'commit');
        wrapper.update();

        commandRegistry.dispatch(workspaceElement, 'github:commit');

        await assert.async.strictEqual(focusElement, commitView.editorElement);
        assert.isFalse(wrapper.instance().getWrappedComponentInstance().commit.called);
      });

      it('creates a commit on github:commit with a nonempty commit message', async function() {
        commitView.editor.setText('I fixed the things');
        sinon.spy(repository, 'commit');

        commandRegistry.dispatch(workspaceElement, 'github:commit');

        await until('Commit method called', () => repository.commit.calledWith('I fixed the things'));
      });
    });
  });

  describe('integration tests', function() {
    it('can stage and unstage files and commit', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepository(workdirPath);
      fs.writeFileSync(path.join(workdirPath, 'a.txt'), 'a change\n');
      fs.unlinkSync(path.join(workdirPath, 'b.txt'));
      const ensureGitTab = () => Promise.resolve(false);

      app = React.cloneElement(app, {repository, ensureGitTab});
      const wrapper = mount(app);

      await assert.async.lengthOf(wrapper.find('GitTabView').prop('unstagedChanges'), 2);

      const gitTab = wrapper.instance().getWrappedComponentInstance().refView;
      const stagingView = gitTab.refStagingView.getWrappedComponent();
      const commitView = wrapper.find('CommitView');

      assert.lengthOf(stagingView.props.unstagedChanges, 2);
      assert.lengthOf(stagingView.props.stagedChanges, 0);

      stagingView.dblclickOnItem({}, stagingView.props.unstagedChanges[0]);

      await assert.async.lengthOf(stagingView.props.unstagedChanges, 1);
      assert.lengthOf(stagingView.props.stagedChanges, 1);

      stagingView.dblclickOnItem({}, stagingView.props.unstagedChanges[0]);

      await assert.async.lengthOf(stagingView.props.unstagedChanges, 0);
      assert.lengthOf(stagingView.props.stagedChanges, 2);

      stagingView.dblclickOnItem({}, stagingView.props.stagedChanges[1]);

      await assert.async.lengthOf(stagingView.props.unstagedChanges, 1);
      assert.lengthOf(stagingView.props.stagedChanges, 1);

      commitView.find('atom-text-editor').getNode().getModel().setText('Make it so');
      commitView.find('.github-CommitView-commit').simulate('click');

      await assert.async.equal((await repository.getLastCommit()).getMessage(), 'Make it so');
    });

    it('can stage merge conflict files', async function() {
      const workdirPath = await cloneRepository('merge-conflict');
      const repository = await buildRepository(workdirPath);

      await assert.isRejected(repository.git.merge('origin/branch'));

      const confirm = sinon.stub();
      app = React.cloneElement(app, {repository, confirm});
      const wrapper = mount(app);

      await assert.async.lengthOf(wrapper.find('GitTabView').prop('mergeConflicts'), 5);
      const stagingView = wrapper.instance().getWrappedComponentInstance().refView.refStagingView.getWrappedComponent();

      assert.equal(stagingView.props.mergeConflicts.length, 5);
      assert.equal(stagingView.props.stagedChanges.length, 0);

      const conflict1 = stagingView.props.mergeConflicts.filter(c => c.filePath === 'modified-on-both-ours.txt')[0];
      const contentsWithMarkers = fs.readFileSync(path.join(workdirPath, conflict1.filePath), {encoding: 'utf8'});
      assert.include(contentsWithMarkers, '>>>>>>>');
      assert.include(contentsWithMarkers, '<<<<<<<');

      // click Cancel
      confirm.returns(1);
      stagingView.dblclickOnItem({}, conflict1);

      await assert.async.isTrue(confirm.calledOnce);
      assert.lengthOf(stagingView.props.mergeConflicts, 5);
      assert.lengthOf(stagingView.props.stagedChanges, 0);

      // click Stage
      confirm.reset();
      confirm.returns(0);
      await stagingView.dblclickOnItem({}, conflict1).selectionUpdatePromise;

      await assert.async.isTrue(confirm.calledOnce);
      await assert.async.lengthOf(stagingView.props.mergeConflicts, 4);
      assert.lengthOf(stagingView.props.stagedChanges, 1);

      // clear merge markers
      const conflict2 = stagingView.props.mergeConflicts.filter(c => c.filePath === 'modified-on-both-theirs.txt')[0];
      confirm.reset();
      fs.writeFileSync(path.join(workdirPath, conflict2.filePath), 'text with no merge markers');
      stagingView.dblclickOnItem({}, conflict2);

      await assert.async.lengthOf(stagingView.props.mergeConflicts, 3);
      assert.lengthOf(stagingView.props.stagedChanges, 2);
      assert.isFalse(confirm.called);
    });

    it('avoids conflicts with pending file staging operations', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepository(workdirPath);
      fs.unlinkSync(path.join(workdirPath, 'a.txt'));
      fs.unlinkSync(path.join(workdirPath, 'b.txt'));

      app = React.cloneElement(app, {repository});
      const wrapper = mount(app);

      const stagingView = wrapper.instance().getWrappedComponentInstance().refView.refStagingView.getWrappedComponent();
      await assert.async.lengthOf(stagingView.props.unstagedChanges, 2);

      // ensure staging the same file twice does not cause issues
      // second stage action is a no-op since the first staging operation is in flight
      const file1StagingPromises = stagingView.confirmSelectedItems();
      stagingView.confirmSelectedItems();

      await file1StagingPromises.stageOperationPromise;
      await file1StagingPromises.selectionUpdatePromise;

      await assert.async.lengthOf(stagingView.props.unstagedChanges, 1);

      const file2StagingPromises = stagingView.confirmSelectedItems();
      await file2StagingPromises.stageOperationPromise;
      await file2StagingPromises.selectionUpdatePromise;

      await assert.async.lengthOf(stagingView.props.unstagedChanges, 0);
    });

    it('updates file status and paths when changed', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepository(workdirPath);
      fs.writeFileSync(path.join(workdirPath, 'new-file.txt'), 'foo\nbar\nbaz\n');

      app = React.cloneElement(app, {repository});
      const wrapper = mount(app);

      const stagingView = wrapper.instance().getWrappedComponentInstance().refView.refStagingView.getWrappedComponent();
      await assert.async.include(stagingView.props.unstagedChanges.map(c => c.filePath), 'new-file.txt');

      const [addedFilePatch] = stagingView.props.unstagedChanges;
      assert.equal(addedFilePatch.filePath, 'new-file.txt');
      assert.equal(addedFilePatch.status, 'added');

      const patchString = dedent`
        --- /dev/null
        +++ b/new-file.txt
        @@ -0,0 +1,1 @@
        +foo

      `;

      // partially stage contents in the newly added file
      await repository.git.applyPatch(patchString, {index: true});
      repository.refresh();

      // since unstaged changes are calculated relative to the index,
      // which now has new-file.txt on it, the working directory version of
      // new-file.txt has a modified status
      await until('modification arrives', () => {
        const [modifiedFilePatch] = stagingView.props.unstagedChanges;
        return modifiedFilePatch.status === 'modified' && modifiedFilePatch.filePath === 'new-file.txt';
      });
    });

    describe('undoLastCommit()', function() {
      it('restores to the state prior to committing', async function() {
        const workdirPath = await cloneRepository('three-files');
        const repository = await buildRepository(workdirPath);
        fs.writeFileSync(path.join(workdirPath, 'new-file.txt'), 'foo\nbar\nbaz\n');

        await repository.stageFiles(['new-file.txt']);
        const commitMessage = 'Commit some stuff';
        await repository.commit(commitMessage);

        app = React.cloneElement(app, {repository});
        const wrapper = mount(app);

        await assert.async.lengthOf(wrapper.find('.github-RecentCommit-undoButton'), 1);
        wrapper.find('.github-RecentCommit-undoButton').simulate('click');

        let commitMessages = wrapper.find('.github-RecentCommit-message').map(node => node.text());
        assert.deepEqual(commitMessages, [commitMessage, 'Initial commit']);

        await assert.async.lengthOf(wrapper.find('GitTabView').prop('stagedChanges'), 1);
        assert.deepEqual(wrapper.find('GitTabView').prop('stagedChanges'), [{
          filePath: 'new-file.txt',
          status: 'added',
        }]);

        commitMessages = wrapper.find('.github-RecentCommit-message').map(node => node.text());
        assert.deepEqual(commitMessages, ['Initial commit']);

        assert.strictEqual(wrapper.find('CommitView').prop('message'), commitMessage);
      });
    });
  });
});
