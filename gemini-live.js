class GeminiRobotLive {
  constructor({
    apiBase,
    getToken,
    getRobotNumber,
    onState = () => {},
    onTranscript = () => {},
    onToolResult = () => {},
    onDebug = () => {},
    onLevel = () => {},
    onStopListening = () => {}
  }) {
    this.apiBase = apiBase.replace(/\/+$/, "");

    this.getToken = getToken;
    this.getRobotNumber = getRobotNumber;

    this.onState = onState;
    this.onTranscript = onTranscript;
    this.onToolResult = onToolResult;
    this.onDebug = onDebug;
    this.onStopListening = onStopListening;

    this.socket = null;
    this.ready = false;
    this.mic = false;

    // Trạng thái phiên Live. Gemini có thể chủ động reset WebSocket; giữ
    // session handle + tự reconnect để mic không "chết" sau lỗi 1011/GoAway.
    this.sessionHandle = "";
    this.wantMic = false;
    this.intentionalClose = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 4;

    // Khi Gemini gọi stop_listening, không đóng phiên ngay. Mic sẽ ngừng thu,
    // Gemini nói câu chào kết thúc, sau đó frontend mới đóng Live session.
    this.stopListeningAfterToolResponse = false;
    this.closeAfterFarewellTurn = false;
    this.farewellCloseTimer = null;

    // Kết quả check-food gần nhất. prepare_delivery chỉ được tạo từ dữ liệu này.
    this.lastFoodCheck = null;

    this.audio = new RobotAudio({
      onLevel,
      onError: (error) => {
        this.onDebug("AUDIO ERROR: " + error.message);
      }
    });
  }

  // =========================================================
  // SYSTEM INSTRUCTION
  // =========================================================

  systemInstruction() {
    const robotNumber = Number(
      this.getRobotNumber?.() || 1
    );

    const identity =
      robotNumber === 1
        ? "Em là nhân viên phục vụ số 1 của nhà hàng Bắc Duyên Hà."
        : `Em là nhân viên phục vụ số ${robotNumber} của nhà hàng Bắc Duyên Hà.`;

    return `
${identity}

Hãy luôn giữ đúng vai trò một nhân viên phục vụ của nhà hàng Bắc Duyên Hà trong toàn bộ cuộc hội thoại.

QUY TẮC VỀ DANH TÍNH VÀ PHONG CÁCH:

1. Khi được hỏi "em là ai", "bạn là ai", "giới thiệu bản thân", "em làm gì ở đây" hoặc câu tương tự:
   - nếu là Robot 1, ưu tiên trả lời theo ý: "Dạ, em là nhân viên phục vụ số 1 của nhà hàng Bắc Duyên Hà ạ.";
   - có thể nói thêm ngắn gọn rằng em hỗ trợ nhận yêu cầu, kiểm tra món, hỗ trợ giao món và phục vụ khách trong nhà hàng.

2. Luôn xưng "em"; gọi người dùng là "anh/chị" hoặc "quý khách" tùy ngữ cảnh. Giọng điệu lễ phép, tự nhiên, thân thiện như một nhân viên phục vụ thực thụ.

2a. QUY TẮC GIỌNG NÓI BẮT BUỘC: khi trả lời bằng âm thanh, luôn nói bằng giọng nữ trẻ theo phong cách Hà Nội / miền Bắc Việt Nam hiện đại. Phát âm tiếng Việt chuẩn miền Bắc, rõ chữ, tốc độ vừa phải, nhẹ nhàng và lịch sự. Tránh ngữ điệu, cách nhấn âm và cách phát âm mang sắc thái Nam Bộ hoặc miền Trung. Không tự chuyển sang giọng nam. Giữ cùng một phong cách giọng miền Bắc trong suốt phiên hội thoại.

2b. Trong các câu xác nhận thông thường, ưu tiên lối nói tự nhiên miền Bắc như "vâng ạ", "vâng, em hiểu ạ", nhưng vẫn giữ nguyên các câu chào/kết thúc đã được hệ thống quy định khi chúng được kích hoạt.

3. Không chủ động tự giới thiệu là Gemini, mô hình AI, trợ lý AI, chatbot, mô hình ngôn ngữ, API hay phần mềm. Không nói về tên model hoặc công nghệ phía sau nếu người dùng không hỏi trực tiếp.

4. Không tự nhận mình là con người. Nếu người dùng hỏi trực tiếp về bản chất kỹ thuật, hãy trả lời trung thực nhưng vẫn giữ vai trò, ví dụ: "Dạ, em là robot phục vụ của nhà hàng Bắc Duyên Hà ạ." rồi quay lại hỗ trợ công việc nhà hàng.

5. Chỉ nói những thông tin về nhà hàng mà hệ thống hoặc tool cung cấp. Không tự bịa địa chỉ, giờ mở cửa, thực đơn, giá món, tên nhân viên, chính sách hoặc thông tin khác chưa có dữ liệu.

6. Khi không có yêu cầu cụ thể, ưu tiên hỏi ngắn gọn: "Dạ anh/chị cần em hỗ trợ gì ạ?"

Luôn trả lời bằng tiếng Việt, ngắn gọn, rõ ràng và lịch sự.

QUY TẮC NGHIỆP VỤ BẮT BUỘC:

1. Khi người dùng yêu cầu mang/giao món tới một bàn,
   phải xác định rõ tên món và số bàn.

2. LUÔN gọi function check_table_food trước khi xác nhận món tồn tại.

3. Tuyệt đối không tự bịa item_id, tên món, số bàn, Line, hướng rẽ, stop_index hoặc trạng thái món.

4. Nếu check_table_food trả found=false hoặc deliverable=false:
   - giải thích ngắn gọn theo đúng tool result;
   - KHÔNG gọi prepare_delivery.

5. Nếu found=true và deliverable=true:
   - đọc lại tên món, số bàn, Line và hướng rẽ;
   - hỏi người dùng xác nhận trước khi nhận nhiệm vụ.

6. CHỈ sau khi người dùng xác nhận rõ ràng như "đồng ý", "xác nhận", "giao đi", "ok"
   mới gọi prepare_delivery.

7. prepare_delivery KHÔNG cho robot chạy ngay. Nó chỉ chuyển frontend sang trạng thái:
   "đã nhận nhiệm vụ - chờ đặt món lên robot".

8. Sau prepare_delivery thành công, nói rõ:
   - nhiệm vụ đã được nhận;
   - hãy đặt món lên robot;
   - robot chỉ bắt đầu dispatch khi cảm biến món của ESP32 (topic/mon) báo đã có món.

9. Nếu người dùng đổi món hoặc đổi bàn trước khi xác nhận, phải gọi check_table_food lại.

10. Route do backend quyết định. Không tự tính hoặc sửa route.

11. Khi người dùng thể hiện rõ là không cần hỗ trợ thêm hoặc muốn kết thúc phiên,
    ví dụ: "được rồi", "thôi được rồi", "không cần nữa", "cảm ơn, thế thôi",
    "xong rồi", "dừng nghe", hãy gọi function stop_listening.
    Không gọi stop_listening khi người dùng chỉ nói "đồng ý", "ok" hoặc "xác nhận"
    trong lúc xác nhận nhiệm vụ giao món.

12. Khi stop_listening trả về success=true, PHẢI nói một câu chào kết thúc lịch sự trước
    khi phiên đóng. Ưu tiên nói đúng câu:
    "Nếu không có việc gì nữa thì em xin phép ạ, cần gì thì cứ gọi em ạ."
    Không hỏi thêm câu hỏi nào sau lời chào này.
`;
  }

  // =========================================================
  // GEMINI TOOLS
  // =========================================================

  tools() {
    return [
      {
        functionDeclarations: [
          {
            name: "check_table_food",
            description:
              "Kiểm tra trong dữ liệu nhà hàng xem một bàn có món người quản lý yêu cầu hay không. Phải gọi trước khi nhận nhiệm vụ giao món.",
            parameters: {
              type: "OBJECT",
              properties: {
                table_number: {
                  type: "INTEGER",
                  description: "Số bàn từ 1 đến 10."
                },
                food_name: {
                  type: "STRING",
                  description: "Tên món ăn người dùng yêu cầu."
                }
              },
              required: ["table_number", "food_name"]
            }
          },
          {
            name: "prepare_delivery",
            description:
              "Sau khi người dùng xác nhận, ghi nhận nhiệm vụ giao món ở frontend và chờ cảm biến món của ESP32 qua topic/mon phát hiện món. Tool này không dispatch database và không publish MQTT.",
            parameters: {
              type: "OBJECT",
              properties: {
                item_id: {
                  type: "INTEGER",
                  description: "ID món chính xác do check_table_food trả về."
                },
                table_number: {
                  type: "INTEGER",
                  description: "Số bàn chính xác do check_table_food trả về."
                }
              },
              required: ["item_id", "table_number"]
            }
          },
          {
            name: "stop_listening",
            description:
              "Dừng nghe khi người dùng nói rằng đã xong, không cần hỗ trợ thêm, hoặc yêu cầu dừng nghe. Sau khi tool thành công, phải nói lời chào kết thúc lịch sự rồi frontend mới đóng phiên. Không dùng tool này cho lời xác nhận nhiệm vụ như 'đồng ý', 'ok', 'xác nhận'.",
            parameters: {
              type: "OBJECT",
              properties: {}
            }
          }
        ]
      }
    ];
  }

  // =========================================================
  // DECODE WEBSOCKET MESSAGE
  // =========================================================

  async decodeWebSocketMessage(data) {
    let text;

    if (typeof data === "string") {
      text = data;
    }

    else if (data instanceof Blob) {
      text = await data.text();
    }

    else if (data instanceof ArrayBuffer) {
      text = new TextDecoder("utf-8").decode(
        new Uint8Array(data)
      );
    }

    else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder("utf-8").decode(data);
    }

    else {
      throw new Error(
        "Unsupported WebSocket data type: " +
        Object.prototype.toString.call(data)
      );
    }

    return JSON.parse(text);
  }

  // =========================================================
  // CONNECT GEMINI LIVE
  // =========================================================

  async connect() {
    if (
      this.socket &&
      this.socket.readyState === WebSocket.OPEN &&
      this.ready
    ) {
      return;
    }

    if (this.socket) {
      // Bỏ handler của socket cũ để việc thay socket không kích hoạt reconnect
      // ngoài ý muốn.
      const oldSocket = this.socket;
      oldSocket.onclose = null;
      oldSocket.onerror = null;
      try {
        oldSocket.close(1000, "replace socket");
      } catch (_) {}

      this.socket = null;
      this.ready = false;
    }

    this.intentionalClose = false;
    this.onState("connecting");

    // Luôn xin ephemeral token MỚI cho mỗi lần mở WebSocket. Nếu token đăng
    // nhập backend đã hết hạn, getGeminiToken() ở app.js sẽ trả 401 rõ ràng.
    const info = await this.getToken();

    if (!info?.token) {
      throw new Error(
        "Backend không trả về Gemini ephemeral token."
      );
    }

    if (!info?.model) {
      throw new Error(
        "Backend không trả về Gemini model."
      );
    }

    const url =
      `${window.APP_CONFIG.GEMINI_WS_BASE}` +
      `?access_token=${encodeURIComponent(info.token)}`;

    this.onDebug(
      `Opening Gemini Live model=${info.model}`
    );

    await new Promise((resolve, reject) => {
      let settled = false;

      const resolveOnce = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      const rejectOnce = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      const ws = new WebSocket(url);

      // Chrome sẽ nhận binary frame dưới dạng ArrayBuffer.
      ws.binaryType = "arraybuffer";

      this.socket = ws;

      const setupTimer = setTimeout(() => {
        this.ready = false;

        rejectOnce(
          new Error(
            "Gemini không trả setupComplete trong 15 giây."
          )
        );

        try {
          ws.close(
            1000,
            "setup timeout"
          );
        } catch (_) {}
      }, 15000);

      // -----------------------------------------------------
      // OPEN
      // -----------------------------------------------------

      ws.onopen = () => {
        this.onDebug(
          "Gemini WebSocket opened"
        );

        this.onDebug(
          `Gemini voice=${window.APP_CONFIG.GEMINI_VOICE_NAME || "Erinome"} · Vietnamese/Hanoi style requested by system instruction`
        );

        const setupMessage = {
          setup: {
            model:
              `models/${info.model}`,

            generationConfig: {
              responseModalities: [
                "AUDIO"
              ],

              // Cố định voice thay vì để Gemini tự chọn.
              // Giá trị mặc định nằm ở config.js -> GEMINI_VOICE_NAME.
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName:
                      window.APP_CONFIG.GEMINI_VOICE_NAME ||
                      "Aoede"
                  }
                }
              }
            },

            systemInstruction: {
              parts: [
                {
                  text:
                    this.systemInstruction()
                }
              ]
            },

            tools:
              this.tools(),

            // Cấu hình VAD rõ ràng để server chốt lượt nói nhanh hơn thay vì
            // phụ thuộc hoàn toàn vào default (dễ kẹt ACTIVITY_START trong môi
            // trường có tiếng ồn nền).
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                prefixPaddingMs: 250,
                silenceDurationMs: 500
              },
              activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
              turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY"
            },

            // Bật session resumption. Khi reconnect sau 1011/GoAway, dùng
            // handle gần nhất để giữ hội thoại nếu Gemini cho phép resume.
            sessionResumption: this.sessionHandle
              ? { handle: this.sessionHandle }
              : {},

            // Tránh phiên audio dài bị chạm giới hạn context.
            contextWindowCompression: {
              slidingWindow: {}
            },

            inputAudioTranscription: {},

            outputAudioTranscription: {}
          }
        };

        this.onDebug(
          "→ SETUP " +
          JSON.stringify(setupMessage)
            .slice(0, 1800)
        );

        ws.send(
          JSON.stringify(setupMessage)
        );
      };

      // -----------------------------------------------------
      // MESSAGE
      // -----------------------------------------------------

      ws.onmessage = async (event) => {
        let message;

        try {
          message =
            await this.decodeWebSocketMessage(
              event.data
            );
        } catch (error) {
          this.onDebug(
            "Gemini message decode error: " +
            error.message
          );

          return;
        }

        // Raw PCM chunks are frequent and large. Logging them forces repeated
        // JSON/base64 processing + DOM updates and can starve realtime audio.
        const hasInlineAudio = Boolean(
          message?.serverContent?.modelTurn?.parts?.some(
            (part) => part?.inlineData?.data
          )
        );

        if (!hasInlineAudio) {
          this.onDebug(
            "← " +
            JSON.stringify(message)
              .slice(0, 1800)
          );
        }

        if (message.setupComplete) {
          clearTimeout(setupTimer);

          this.ready = true;

          this.reconnectAttempts = 0;

          this.onState(
            this.mic ? "listening" : "ready"
          );

          this.onDebug(
            "Gemini setupComplete ✓" +
            (this.sessionHandle ? " (session resumable)" : "")
          );

          resolveOnce();

          return;
        }

        try {
          await this.handle(message);
        } catch (error) {
          this.onDebug(
            "Gemini handle error: " +
            error.message
          );
        }
      };

      // -----------------------------------------------------
      // ERROR
      // -----------------------------------------------------

      ws.onerror = () => {
        clearTimeout(setupTimer);

        this.ready = false;
        this.onDebug("Gemini WebSocket error event.");

        // onclose thường chạy ngay sau onerror và chứa code/reason hữu ích hơn.
        // Chỉ reject ngay nếu setup chưa hoàn tất; nếu phiên đang chạy thì
        // onclose sẽ đảm nhiệm việc reconnect.
        rejectOnce(
          new Error(
            "Gemini WebSocket error."
          )
        );
      };

      // -----------------------------------------------------
      // CLOSE
      // -----------------------------------------------------

      ws.onclose = (event) => {
        clearTimeout(setupTimer);

        const wasReady =
          this.ready;
        const shouldReconnect =
          !this.intentionalClose &&
          (this.wantMic || this.mic);

        this.ready = false;
        this.audio.stopPlayback();

        this.onDebug(
          `CLOSE ${event.code} ${event.reason || ""}`
        );

        if (!wasReady) {
          rejectOnce(
            new Error(
              `Gemini đóng kết nối: ` +
              `${event.code} ${event.reason || ""}`
            )
          );
        }

        if (shouldReconnect) {
          // Không tắt MediaStream: callback mic sẽ tự bỏ chunk trong lúc
          // ready=false và gửi tiếp ngay sau khi socket mới setupComplete.
          this.onState("connecting");
          this.scheduleReconnect(
            `close ${event.code} ${event.reason || ""}`
          );
        } else {
          this.mic = false;
          this.audio.stop();
          this.onState("closed");
        }
      };
    });
  }

  // =========================================================
  // RECEIVE GEMINI SERVER MESSAGE
  // =========================================================

  async handle(message) {
    const content =
      message.serverContent;

    if (content?.interrupted) {
      this.audio.stopPlayback();

      this.onState(
        this.mic
          ? "listening"
          : "ready"
      );
    }

    if (
      content
        ?.inputTranscription
        ?.text
    ) {
      this.onTranscript(
        "user",
        content.inputTranscription.text
      );
    }

    if (
      content
        ?.outputTranscription
        ?.text
    ) {
      this.onTranscript(
        "assistant",
        content.outputTranscription.text
      );
    }

    const parts =
      content
        ?.modelTurn
        ?.parts || [];

    for (const part of parts) {
      if (
        part.inlineData &&
        part.inlineData.data
      ) {
        this.onState(
          "speaking"
        );

        await this.audio.play(
          part.inlineData.data,
          part.inlineData.mimeType ||
            "audio/pcm;rate=24000"
        );
      }

      if (part.text) {
        this.onDebug(
          "MODEL TEXT: " +
          part.text
        );
      }
    }

    if (content?.turnComplete) {
      this.onState(
        this.mic
          ? "listening"
          : "ready"
      );

      // Sau stop_listening, turn này là lời chào kết thúc của Gemini.
      // Chờ thêm một khoảng để PCM đã queue phát hết rồi mới đóng socket,
      // tránh cắt ngang câu nói ở cuối.
      if (this.closeAfterFarewellTurn) {
        this.closeAfterFarewellTurn = false;

        if (this.farewellCloseTimer) {
          clearTimeout(this.farewellCloseTimer);
        }

        this.farewellCloseTimer = window.setTimeout(() => {
          this.farewellCloseTimer = null;
          this.close();
          this.onState("closed");
          this.onStopListening();
        }, 5000);
      }
    }

    if (message.toolCall) {
      await this.handleTool(
        message.toolCall
      );
    }

    if (message.goAway) {
      this.onDebug(
        "GO_AWAY " +
        JSON.stringify(message.goAway)
      );
      // Không đóng socket ngay: Gemini sẽ đóng sau timeLeft. onclose sẽ
      // reconnect bằng handle mới nhất để tránh mất lượt đang xử lý.
    }

    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;

      if (update.resumable && update.newHandle) {
        this.sessionHandle = String(update.newHandle);
      }

      this.onDebug(
        "SESSION_RESUMPTION " +
        JSON.stringify(update)
      );
    }
  }

  // =========================================================
  // HANDLE GEMINI FUNCTION CALL
  // =========================================================

  async handleTool(toolCall) {
    const responses = [];

    for (
      const functionCall
      of toolCall.functionCalls || []
    ) {
      this.onState(
        "thinking"
      );

      this.onDebug(
        `TOOL CALL ${functionCall.name} ` +
        JSON.stringify(
          functionCall.args || {}
        )
      );

      let result;

      try {
        result =
          await this.execTool(
            functionCall.name,
            functionCall.args || {}
          );
      } catch (error) {
        result = {
          success: false,
          error:
            error.message
        };
      }

      this.onToolResult(
        functionCall.name,
        result
      );

      responses.push({
        name:
          functionCall.name,

        id:
          functionCall.id,

        response: {
          result
        }
      });
    }

    if (!responses.length) {
      return;
    }

    this.send({
      toolResponse: {
        functionResponses:
          responses
      }
    });

    // Với stop_listening, giữ socket mở để Gemini còn nói lời chào kết thúc.
    // Mic đã được dừng trong execTool(), nên robot không tiếp tục thu lời người dùng.
    if (this.stopListeningAfterToolResponse) {
      this.stopListeningAfterToolResponse = false;
      this.closeAfterFarewellTurn = true;

      // Fallback: nếu vì lỗi mạng/model mà không bao giờ nhận turnComplete,
      // vẫn đóng phiên sau một khoảng đủ dài để tránh treo chế độ Gemini.
      if (this.farewellCloseTimer) {
        clearTimeout(this.farewellCloseTimer);
      }

      this.farewellCloseTimer = window.setTimeout(() => {
        this.farewellCloseTimer = null;
        this.closeAfterFarewellTurn = false;
        this.close();
        this.onState("closed");
        this.onStopListening();
      }, 12000);
    }
  }

  // =========================================================
  // EXECUTE TOOLS THROUGH FASTAPI
  // =========================================================

  async execTool(
    name,
    args
  ) {
    if (
      name ===
      "check_table_food"
    ) {
      const result = await this.authFetch(
        "/robot-ai/check-food",
        {
          method: "POST",
          body: JSON.stringify({
            table_number: Number(args.table_number),
            food_name: String(args.food_name || "")
          })
        }
      );

      this.lastFoodCheck = result;
      return result;
    }

    if (
      name ===
      "prepare_delivery"
    ) {
      const checked = this.lastFoodCheck;

      if (!checked?.found || !checked?.deliverable || !checked?.item) {
        throw new Error(
          "Chưa có kết quả check_table_food hợp lệ để nhận nhiệm vụ."
        );
      }

      const itemId = Number(args.item_id);
      const tableNumber = Number(args.table_number);
      const checkedItemId = Number(checked.item.id);
      const checkedTable = Number(checked.table_number);

      if (itemId !== checkedItemId || tableNumber !== checkedTable) {
        throw new Error(
          "item_id hoặc table_number không khớp kết quả check_table_food gần nhất."
        );
      }

      return {
        success: true,
        accepted: true,
        waiting_for_food: true,
        item_id: checkedItemId,
        table_number: checkedTable,
        table: checkedTable,
        food_name: checked.item.food_name,
        route: checked.route,
        message: "Đã nhận nhiệm vụ. Đang chờ cảm biến món của ESP32 xác nhận món đã được đặt lên robot."
      };
    }

    if (
      name ===
      "stop_listening"
    ) {
      // Ngừng thu âm ngay để không tiếp tục xử lý lời nói mới, nhưng vẫn giữ
      // WebSocket/output audio mở để Gemini nói lời chào kết thúc.
      if (this.mic) {
        this.stopMic();
      } else {
        this.wantMic = false;
      }

      this.stopListeningAfterToolResponse = true;

      return {
        success: true,
        stopped: true,
        farewell_required: true,
        farewell_text:
          "Nếu không có việc gì nữa thì em xin phép ạ, cần gì thì cứ gọi em ạ.",
        message:
          "Đã ngừng thu microphone. Hãy nói farewell_text rồi kết thúc lượt trả lời."
      };
    }

    throw new Error(
      "Unknown Gemini tool: " + name
    );
  }

  // =========================================================
  // AUTH FETCH
  // =========================================================

  async authFetch(
    path,
    options = {}
  ) {
    const token =
      localStorage.getItem(
        "restaurant_access_token"
      );

    if (!token) {
      const error =
        new Error(
          "Chưa đăng nhập backend."
        );

      error.status = 401;

      throw error;
    }

    const response =
      await fetch(
        this.apiBase + path,
        {
          ...options,

          headers: {
            "Content-Type":
              "application/json",

            "Authorization":
              `Bearer ${token}`,

            ...(options.headers || {})
          }
        }
      );

    const data =
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {
      const error =
        new Error(
          data.detail ||
          data.message ||
          `HTTP ${response.status}`
        );

      error.status =
        response.status;

      error.data =
        data;

      throw error;
    }

    return data;
  }

  // =========================================================
  // AUTO RECONNECT GEMINI LIVE
  // =========================================================

  scheduleReconnect(reason = "socket closed") {
    if (this.intentionalClose || (!this.wantMic && !this.mic)) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.onDebug(
        `Gemini reconnect failed after ${this.reconnectAttempts} attempts.`
      );
      this.wantMic = false;
      this.mic = false;
      this.audio.stop();
      this.onState("error");
      return;
    }

    const delays = [300, 800, 1500, 3000];
    const attempt = this.reconnectAttempts + 1;
    const delay = delays[Math.min(this.reconnectAttempts, delays.length - 1)];
    this.reconnectAttempts = attempt;

    this.onDebug(
      `Gemini reconnect #${attempt} in ${delay}ms (${reason})`
    );

    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null;

      try {
        await this.connect();
        this.onDebug(`Gemini reconnect #${attempt} ✓`);
        this.onState(this.mic ? "listening" : "ready");
      } catch (error) {
        this.onDebug(
          `Gemini reconnect #${attempt} failed: ${error.message}`
        );

        // Nếu handle cũ không còn hợp lệ, lần kế tiếp mở session mới.
        if (attempt >= 2) {
          this.sessionHandle = "";
        }

        this.scheduleReconnect(error.message);
      }
    }, delay);
  }

  // =========================================================
  // START MICROPHONE
  // =========================================================

  async startMic() {
    this.wantMic = true;
    this.intentionalClose = false;

    try {
      await this.connect();
    } catch (error) {
      this.wantMic = false;
      throw error;
    }

    if (this.mic) {
      return;
    }

    if (
      !this.ready ||
      this.socket
        ?.readyState
        !== WebSocket.OPEN
    ) {
      throw new Error(
        "Gemini chưa sẵn sàng."
      );
    }

    this.mic =
      true;

    this.onState(
      "listening"
    );

    await this.audio.start(
      (pcmBuffer) => {
        if (
          !this.ready ||
          this.socket
            ?.readyState
            !== WebSocket.OPEN
        ) {
          return;
        }

        this.send({
          realtimeInput: {
            audio: {
              data:
                this.audio.toB64(
                  pcmBuffer
                ),

              mimeType:
                "audio/pcm;rate=16000"
            }
          }
        });
      }
    );
  }

  // =========================================================
  // STOP MICROPHONE
  // =========================================================

  stopMic() {
    this.wantMic = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.mic) {
      return;
    }

    this.mic =
      false;

    this.audio.stop();

    if (
      this.ready &&
      this.socket
        ?.readyState
        === WebSocket.OPEN
    ) {
      this.send({
        realtimeInput: {
          audioStreamEnd:
            true
        }
      });
    }

    this.onState(
      "ready"
    );
  }

  // =========================================================
  // SEND DEBUG TEXT
  // =========================================================

  async sendText(
    text,
    options = {}
  ) {
    const value =
      String(text || "")
        .trim();

    if (!value) {
      return;
    }

    await this.connect();

    if (!this.ready) {
      throw new Error(
        "Gemini chưa setup xong."
      );
    }

    if (options.showTranscript !== false) {
      this.onTranscript(
        "user",
        value
      );
    }

    this.send({
      clientContent: {
        turns: [
          {
            role:
              "user",

            parts: [
              {
                text:
                  value
              }
            ]
          }
        ],

        turnComplete:
          true
      }
    });
  }

  // =========================================================
  // SEND JSON TO GEMINI
  // =========================================================

  send(object) {
    if (
      !this.socket ||
      this.socket
        .readyState
        !== WebSocket.OPEN
    ) {
      throw new Error(
        "Gemini WebSocket chưa mở."
      );
    }

    const payload =
      JSON.stringify(object);

    // Do not dump microphone PCM/base64 into the UI debug log. At 48 kHz with
    // ScriptProcessor(4096) this can happen ~12 times/second and causes jank.
    const isMicAudio = Boolean(
      object?.realtimeInput?.audio?.data
    );

    if (!isMicAudio) {
      this.onDebug(
        "→ " +
        payload.slice(0, 1600)
      );
    }

    this.socket.send(payload);
  }

  // =========================================================
  // CLOSE SESSION
  // =========================================================

  close() {
    this.intentionalClose = true;
    this.wantMic = false;
    this.closeAfterFarewellTurn = false;

    if (this.farewellCloseTimer) {
      clearTimeout(this.farewellCloseTimer);
      this.farewellCloseTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.mic) {
      this.stopMic();
    }

    this.audio.stopPlayback();

    if (this.socket) {
      try {
        this.socket.close(
          1000,
          "user close"
        );
      } catch (_) {}
    }

    this.socket =
      null;

    this.ready =
      false;

    this.mic =
      false;

    this.sessionHandle = "";
    this.reconnectAttempts = 0;
  }
}

window.GeminiRobotLive =
  GeminiRobotLive;