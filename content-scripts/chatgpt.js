let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let checkIntervalId = null;
let observer = null;
let lastAssistantMessage = null;
let lastAssistantSignature = "";

const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
const CHAT_INPUT_SELECTORS = [
  "#prompt-textarea",
  'textarea[data-testid="prompt-textarea"]',
  "textarea",
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"]',
];
const SEND_BUTTON_SELECTORS = [
  '[data-testid="send-button"]',
  '[data-testid="composer-send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[type="submit"]',
];
const CHATGPT_ERROR_PATTERNS = [
  /you(?:'|’)ve reached.*limit/i,
  /usage limit/i,
  /rate limit/i,
  /try again later/i,
  /something went wrong/i,
  /unable to (?:generate|respond)/i,
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();

    const messages = getAssistantMessages();
    messageCountAtQuestion = messages.length;
    lastAssistantMessage = messages[messages.length - 1] || null;
    lastAssistantSignature = getMessageSignature(lastAssistantMessage);
    hasResponded = false;

    insertQuestion(message.question)
      .then(() => {
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function resetObservation() {
  hasResponded = false;
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  lastAssistantMessage = null;
  lastAssistantSignature = "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAssistantMessages() {
  return Array.from(document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR));
}

function getMessageText(message) {
  return (message?.innerText || message?.textContent || "").trim();
}

function getMessageSignature(message) {
  return getMessageText(message).replace(/\s+/g, " ").slice(0, 1000);
}

function findChatInput() {
  for (const selector of CHAT_INPUT_SELECTORS) {
    const input = document.querySelector(selector);
    if (input) return input;
  }
  return null;
}

function isButtonUsable(button) {
  if (!button) return false;
  if (button.disabled) return false;
  if (button.getAttribute("aria-disabled") === "true") return false;

  const label = `${button.getAttribute("aria-label") || ""} ${
    button.getAttribute("data-testid") || ""
  } ${button.textContent || ""}`;
  if (/stop|cancel|voice|attach|upload/i.test(label)) return false;

  return true;
}

function findSendButton() {
  for (const selector of SEND_BUTTON_SELECTORS) {
    const buttons = Array.from(document.querySelectorAll(selector));
    const usableButton = buttons.find((button) => isButtonUsable(button));
    if (usableButton) return usableButton;
  }

  const input = findChatInput();
  const form = input?.closest("form");
  if (form) {
    const buttons = Array.from(form.querySelectorAll("button, [role='button']"));
    return buttons.reverse().find((button) => isButtonUsable(button)) || null;
  }

  return null;
}

function setNativeValue(element, value) {
  const prototype = Object.getPrototypeOf(element);
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  if (valueSetter) {
    valueSetter.call(element, value);
  } else {
    element.value = value;
  }
}

function updateChatInputValue(chatInput, text) {
  chatInput.focus();

  if (
    chatInput instanceof HTMLTextAreaElement ||
    chatInput instanceof HTMLInputElement
  ) {
    setNativeValue(chatInput, text);
  } else if (chatInput.isContentEditable) {
    chatInput.innerHTML = "";
    text.split("\n").forEach((line) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line || "\u00a0";
      chatInput.appendChild(paragraph);
    });
  } else {
    return false;
  }

  chatInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  chatInput.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

async function waitForSendButton(timeout = 5000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const sendButton = findSendButton();
    if (sendButton) return sendButton;
    await delay(100);
  }
  return null;
}

async function insertQuestion(questionData) {
  const { type, question, options, previousCorrection } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text =
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${
        previousCorrection.question
      }", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question:\n\n` + text;
  }

  if (type === "matching") {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      '\n\nPlease match each prompt with the correct choice. Set "answer" to an array of strings using the exact format \'Prompt -> Choice\'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
  }

  text +=
    '\n\nIMPORTANT: Your answer should be in a JSON code block.' +
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  const inputArea = findChatInput();
  if (!inputArea) {
    throw new Error("Input area not found");
  }

  await delay(300);
  if (!updateChatInputValue(inputArea, text)) {
    throw new Error("Unable to fill input area");
  }

  const sendButton = await waitForSendButton();
  if (!sendButton) {
    throw new Error("Send button not found or disabled");
  }

  sendButton.click();
  startObserving();
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      notifyWorkflowError(
        "Timed out waiting for ChatGPT to return a usable JSON answer."
      );
    }
  }, 180000);

  observer = new MutationObserver(() => {
    checkForResponse();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });

  checkIntervalId = setInterval(checkForResponse, 1000);
}

function cleanResponseText(responseText) {
  return responseText
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\n\s*/g, " ")
    .trim();
}

function hasAnswerKey(parsed) {
  return (
    parsed &&
    typeof parsed === "object" &&
    Object.prototype.hasOwnProperty.call(parsed, "answer")
  );
}

function extractBalancedJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return "";

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return "";
}

function extractJsonCandidates(message) {
  const candidates = [];
  const codeBlocks = message.querySelectorAll("pre code, pre");

  for (const block of codeBlocks) {
    const text = block.textContent.trim();
    if (text.includes("{") && text.includes('"answer"')) {
      candidates.push(text);
    }
  }

  const messageText = getMessageText(message);
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fencedMatch = fencedRegex.exec(messageText);
  while (fencedMatch) {
    candidates.push(fencedMatch[1].trim());
    fencedMatch = fencedRegex.exec(messageText);
  }

  const balancedJson = extractBalancedJson(messageText);
  if (balancedJson) candidates.push(balancedJson);

  return candidates;
}

function processResponse(responseText) {
  const cleanedText = cleanResponseText(responseText);

  try {
    const parsed = JSON.parse(cleanedText);
    if (hasAnswerKey(parsed) && !hasResponded) {
      hasResponded = true;
      chrome.runtime
        .sendMessage({
          type: "chatGPTResponse",
          response: cleanedText,
        })
        .then(() => {
          resetObservation();
        })
        .catch((error) => {
          console.error("Error sending response:", error);
        });
      return true;
    }
  } catch (e) {
    return false;
  }

  return false;
}

function getCandidateMessages(messages) {
  const lastMessageIndex = lastAssistantMessage
    ? messages.indexOf(lastAssistantMessage)
    : -1;

  if (lastMessageIndex >= 0) {
    return messages.slice(lastMessageIndex + 1);
  }

  if (messages.length > messageCountAtQuestion) {
    return messages.slice(messageCountAtQuestion);
  }

  const latestMessage = messages[messages.length - 1];
  const latestSignature = getMessageSignature(latestMessage);
  if (latestSignature && latestSignature !== lastAssistantSignature) {
    return [latestMessage];
  }

  return [];
}

function isChatGPTGenerating() {
  const stopButton = document.querySelector(
    '[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Cancel"]'
  );
  return Boolean(stopButton);
}

function isKnownChatGPTError(text) {
  return CHATGPT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function checkForResponse() {
  if (hasResponded) return;

  const messages = getAssistantMessages();
  if (!messages.length) return;

  const candidateMessages = getCandidateMessages(messages);

  for (let i = candidateMessages.length - 1; i >= 0; i -= 1) {
    const message = candidateMessages[i];
    const candidates = extractJsonCandidates(message);
    for (const candidate of candidates) {
      if (processResponse(candidate)) return;
    }
  }

  const latestMessage = candidateMessages[candidateMessages.length - 1];
  if (
    latestMessage &&
    !isChatGPTGenerating() &&
    Date.now() - observationStartTime > 10000
  ) {
    const messageText = getMessageText(latestMessage);
    if (isKnownChatGPTError(messageText)) {
      notifyWorkflowError(messageText);
    }
  }
}

function notifyWorkflowError(message) {
  if (hasResponded) return;

  hasResponded = true;
  chrome.runtime
    .sendMessage({
      type: "aiWorkflowError",
      aiType: "ChatGPT",
      message,
    })
    .finally(() => {
      resetObservation();
    });
}
