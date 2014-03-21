"use strict";
var Rsvp = require("rsvp")["default"];
var ResolvedHandlerInfo = require("./handler-info").ResolvedHandlerInfo;
var trigger = require("./utils").trigger;
var slice = require("./utils").slice;
var log = require("./utils").log;
var promiseLabel = require("./utils").promiseLabel;

var Promise = Rsvp.Promise;

/**
  @private

  A Transition is a thennable (a promise-like object) that represents
  an attempt to transition to another route. It can be aborted, either
  explicitly via `abort` or by attempting another transition while a
  previous one is still underway. An aborted transition can also
  be `retry()`d later.
 */
function Transition(router, intent, state, error) {
  var transition = this;
  this.state = state || router.state;
  this.intent = intent;
  this.router = router;
  this.data = this.intent && this.intent.data || {};
  this.resolvedModels = {};
  this.queryParams = {};

  if (error) {
    this.promise = Promise.reject(error);
    return;
  }

  if (state) {
    this.params = state.params;
    this.queryParams = state.queryParams;

    var len = state.handlerInfos.length;
    if (len) {
      this.targetName = state.handlerInfos[state.handlerInfos.length-1].name;
    }

    for (var i = 0; i < len; ++i) {
      var handlerInfo = state.handlerInfos[i];
      if (!(handlerInfo instanceof ResolvedHandlerInfo)) {
        break;
      }
      this.pivotHandler = handlerInfo.handler;
    }

    this.sequence = Transition.currentSequence++;
    this.promise = state.resolve(router.async, checkForAbort, this)['catch'](function(result) {
      if (result.wasAborted) {
        return Promise.reject(logAbort(transition));
      } else {
        transition.trigger('error', result.error, transition, result.handlerWithError);
        transition.abort();
        return Promise.reject(result.error);
      }
    }, promiseLabel('Handle Abort'));
  } else {
    this.promise = Promise.resolve(this.state);
    this.params = {};
  }

  function checkForAbort() {
    if (transition.isAborted) {
      return Promise.reject(undefined, promiseLabel("Transition aborted - reject"));
    }
  }
}

Transition.currentSequence = 0;

Transition.prototype = {
  targetName: null,
  urlMethod: 'update',
  intent: null,
  params: null,
  pivotHandler: null,
  resolveIndex: 0,
  handlerInfos: null,
  resolvedModels: null,
  isActive: true,
  state: null,

  /**
    @public

    The Transition's internal promise. Calling `.then` on this property
    is that same as calling `.then` on the Transition object itself, but
    this property is exposed for when you want to pass around a
    Transition's promise, but not the Transition object itself, since
    Transition object can be externally `abort`ed, while the promise
    cannot.
   */
  promise: null,

  /**
    @public

    Custom state can be stored on a Transition's `data` object.
    This can be useful for decorating a Transition within an earlier
    hook and shared with a later hook. Properties set on `data` will
    be copied to new transitions generated by calling `retry` on this
    transition.
   */
  data: null,

  /**
    @public

    A standard promise hook that resolves if the transition
    succeeds and rejects if it fails/redirects/aborts.

    Forwards to the internal `promise` property which you can
    use in situations where you want to pass around a thennable,
    but not the Transition itself.

    @param {Function} success
    @param {Function} failure
   */
  then: function(success, failure) {
    return this.promise.then(success, failure);
  },

  /**
    @public

    Aborts the Transition. Note you can also implicitly abort a transition
    by initiating another transition while a previous one is underway.
   */
  abort: function() {
    if (this.isAborted) { return this; }
    log(this.router, this.sequence, this.targetName + ": transition was aborted");
    this.isAborted = true;
    this.isActive = false;
    this.router.activeTransition = null;
    return this;
  },

  /**
    @public

    Retries a previously-aborted transition (making sure to abort the
    transition if it's still active). Returns a new transition that
    represents the new attempt to transition.
   */
  retry: function() {
    // TODO: add tests for merged state retry()s
    this.abort();
    return this.router.transitionByIntent(this.intent, false);
  },

  /**
    @public

    Sets the URL-changing method to be employed at the end of a
    successful transition. By default, a new Transition will just
    use `updateURL`, but passing 'replace' to this method will
    cause the URL to update using 'replaceWith' instead. Omitting
    a parameter will disable the URL change, allowing for transitions
    that don't update the URL at completion (this is also used for
    handleURL, since the URL has already changed before the
    transition took place).

    @param {String} method the type of URL-changing method to use
      at the end of a transition. Accepted values are 'replace',
      falsy values, or any other non-falsy value (which is
      interpreted as an updateURL transition).

    @return {Transition} this transition
   */
  method: function(method) {
    this.urlMethod = method;
    return this;
  },

  /**
    @public

    Fires an event on the current list of resolved/resolving
    handlers within this transition. Useful for firing events
    on route hierarchies that haven't fully been entered yet.

    Note: This method is also aliased as `send`

    @param {Boolean} [ignoreFailure=false] a boolean specifying whether unhandled events throw an error
    @param {String} name the name of the event to fire
   */
  trigger: function (ignoreFailure) {
    var args = slice.call(arguments);
    if (typeof ignoreFailure === 'boolean') {
      args.shift();
    } else {
      // Throw errors on unhandled trigger events by default
      ignoreFailure = false;
    }
    trigger(this.router, this.state.handlerInfos.slice(0, this.resolveIndex + 1), ignoreFailure, args);
  },

  /**
    @public

    Transitions are aborted and their promises rejected
    when redirects occur; this method returns a promise
    that will follow any redirects that occur and fulfill
    with the value fulfilled by any redirecting transitions
    that occur.

    @return {Promise} a promise that fulfills with the same
      value that the final redirecting transition fulfills with
   */
  followRedirects: function() {
    var router = this.router;
    return this.promise['catch'](function(reason) {
      if (router.activeTransition) {
        return router.activeTransition.followRedirects();
      }
      return Promise.reject(reason);
    });
  },

  toString: function() {
    return "Transition (sequence " + this.sequence + ")";
  },

  /**
    @private
   */
  log: function(message) {
    log(this.router, this.sequence, message);
  }
};

// Alias 'trigger' as 'send'
Transition.prototype.send = Transition.prototype.trigger;

/**
  @private

  Logs and returns a TransitionAborted error.
 */
function logAbort(transition) {
  log(transition.router, transition.sequence, "detected abort.");
  return new TransitionAborted();
}

function TransitionAborted(message) {
  this.message = (message || "TransitionAborted");
  this.name = "TransitionAborted";
}

exports.Transition = Transition;
exports.logAbort = logAbort;
exports.TransitionAborted = TransitionAborted;