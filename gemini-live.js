class GeminiRobotLive {
  constructor({
    apiBase,
    getToken,
    getRobotNumber,
    getRobotContext = () => ({}),
    onState = () => {},
    onTranscript = () => {},
    onToolResult = () => {},
    onDebug = () => {},
    onLevel = () => {},
    onStopListening = () => {},
    onTurnComplete = () => {}
  }) {
    this.apiBase = apiBase.replace(/\/+$/, "");

    this.getToken = getToken;
    this.getRobotNumber = getRobotNumber;
    this.getRobotContext = getRobotContext;

    this.onState = onState;
    this.onTranscript = onTranscript;
    this.onToolResult = onToolResult;
    this.onDebug = onDebug;
    this.onStopListening = onStopListening;
    this.onTurnComplete = onTurnComplete;

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

QUY TẮC NHẬN BIẾT ROBOT VÀ CÔNG VIỆC HIỆN TẠI:

1. Khi người dùng hỏi về chính robot hiện tại, ví dụ: "em đang làm gì", "em đang đi đâu", "đang giao món gì", "đi bàn nào", "đã tới bàn chưa", "nhiệm vụ hiện tại là gì", "em có đang rảnh không", LUÔN gọi function read_robot_context trước khi trả lời. Không suy đoán từ hội thoại cũ.

2. read_robot_context là nguồn sự thật của frontend về robot đang được chọn. Phải dùng robot_number, alive, status, task_type và tasks mà tool trả về.

2a. task_type cho biết LOẠI NHIỆM VỤ, còn status cho biết GIAI ĐOẠN THỰC HIỆN. Hiện nhiệm vụ giao món dùng task_type="food_delivery". Với dữ liệu task cũ chưa có task_type, coi là "food_delivery" để tương thích ngược; không được tự suy ra một loại nhiệm vụ khác.

3. Diễn giải work status như sau:
   - available: trả lời rằng em đang sẵn sàng làm việc và hiện chưa có nhiệm vụ đang thực hiện.
   - received_task: đọc tasks để nói rõ em đã nhận nhiệm vụ chuẩn bị giao món gì tới bàn nào nhưng chưa bắt đầu chạy; có thể bắt đầu bằng nút BẮT ĐẦU hoặc lời nói "giao món đi".
   - on_task: đọc tasks để nói rõ em đang thực hiện nhiệm vụ giao món gì tới bàn nào; nếu route có line/hướng rẽ thì chỉ nêu khi người dùng hỏi chi tiết.
   - on_target: đọc tasks để nói rõ em đã đến bàn đích nào với món gì và đang chờ khách lấy món khỏi robot.
   - on_home, come_home hoặc come_back: trả lời rằng em đã hoàn tất phần giao món và đang trên đường trở về vị trí chờ của robot.
   - abnormal_behavior: nói rằng robot đang ở trạng thái hoạt động bất thường; không tự bịa nguyên nhân nếu dữ liệu không cung cấp.

4. Alive và work status là hai khái niệm riêng. Nếu người dùng hỏi robot có đang kết nối/sống hay không, trả lời theo field alive của tool. Không suy ra alive chỉ từ work status.

5. Nếu tasks không có đủ food_name/table thì nói đúng phần thông tin hiện có, không tự bịa món hoặc bàn.

6. Khi người dùng hỏi thông tin/order của một bàn cụ thể, gọi read_table_info trước khi trả lời. Khi hỏi menu chung, vẫn dùng read_menu.

QUY TẮC TƯ VẤN MENU BẮT BUỘC:

1. Khi khách hỏi về menu, món ăn, đồ uống, giá, thành phần, món đang bán, hoặc nhờ tư vấn/chọn món, LUÔN gọi function read_menu trước khi trả lời.

2. Chỉ tư vấn dựa trên dữ liệu mà read_menu trả về. Không tự bịa món, giá, nguyên liệu, tình trạng available hoặc mô tả không có trong data.js.

3. Khi khách hỏi chung như "menu có gì", "tư vấn món cho tôi", "món nào ngon", có thể gọi read_menu với query rỗng để lấy toàn bộ menu đang available rồi chọn một vài món phù hợp và nêu giá.

4. Khi khách nêu sở thích hoặc nguyên liệu như "món bò", "món cay", "dưới 60 nghìn", hãy truyền thông tin phù hợp vào read_menu để lọc trước khi tư vấn.

5. Nếu khách hỏi dị ứng hoặc kiêng một nguyên liệu, chỉ được căn cứ danh sách ingredients trong data.js. Dữ liệu này không phải chứng nhận dị ứng; nếu có rủi ro dị ứng nghiêm trọng, phải nói rõ nên xác nhận lại với nhân viên/bếp.

6. read_menu chỉ dùng để tra cứu/tư vấn menu. Nếu khách yêu cầu GIAO một món tới bàn, sau khi xác định món vẫn phải tuân theo quy trình check_table_food → xác nhận → prepare_delivery ở bên dưới.

QUY TẮC NGHIỆP VỤ GIAO MÓN BẮT BUỘC:

1. Với MỌI yêu cầu giao/mang món tới bàn, trước hết LUÔN gọi read_robot_context để đọc status và task thật của robot. Không nhận task mới chỉ dựa vào nội dung hội thoại.

2. Nếu status=abnormal_behavior: KHÔNG nhận task và nói theo ý: "Đang có vấn đề với robot, vui lòng kiểm tra ạ."

3. Nếu status=on_task, on_target, on_home, come_home hoặc come_back: KHÔNG nhận task mới. Đọc tasks và nói theo ý: "Em đang bận giao món {x} tới bàn {y}, em sẽ trở lại ngay ạ."

4. Nếu status=received_task, đây là trạng thái đặc biệt vì robot đã nhận task nhưng chưa chạy:
   - vẫn phải xác định rõ món mới và bàn mới rồi gọi check_table_food để đối chiếu;
   - nếu check_table_food trả same_as_current_task=true, hoặc yêu cầu có cùng food_name + table với task hiện tại, coi là CÙNG NHIỆM VỤ. Khi đó KHÔNG tạo task mới, kể cả món đang dispatched; chỉ nói: "Em đã sẵn sàng, hãy bấm Bắt đầu hoặc ra lệnh giao món đi ạ."
   - nếu nhiệm vụ mới KHÁC task hiện tại và món mới deliverable=true, phải hỏi quản lý có muốn bỏ nhiệm vụ cũ để thay bằng nhiệm vụ mới hay không. Nêu rõ nhiệm vụ cũ và nhiệm vụ mới.
   - chỉ khi quản lý xác nhận thay task mới gọi prepare_task_replacement. Không tự ghi đè task.
   - sau khi prepare_task_replacement trả accepted=true, đọc field prompt của tool và nói đúng yêu cầu đó cho quản lý; frontend sẽ dùng cảm biến để tiếp tục các bước lấy món cũ/đặt món mới.
   - nếu quản lý không xác nhận thay task, giữ task cũ và nói hãy bấm Bắt đầu hoặc ra lệnh "giao món đi" để giao nhiệm vụ trước đó.

5. Nếu status=available:
   - xác định rõ food_name và table_number;
   - gọi check_table_food;
   - nếu found=false hoặc deliverable=false thì giải thích đúng tool result và KHÔNG gọi prepare_delivery;
   - nếu found=true và deliverable=true, đọc lại tên món, số bàn, Line và hướng rẽ rồi hỏi xác nhận;
   - chỉ sau xác nhận rõ ràng mới gọi prepare_delivery.

6. prepare_delivery phải tôn trọng Alive. Nếu tool trả robot_not_alive/disconnected, nói "Hãy bật robot lên ạ." và không tạo pending dispatch. Nếu robot alive nhưng chưa có món, nói "Đã nhận yêu cầu - hãy mau đặt món lên robot ạ." Frontend sẽ chờ topic/mon current=0 rồi tự gọi confirm-dispatch.

7. Route luôn do backend quyết định. Tuyệt đối không tự bịa hoặc tự sửa item_id, table, line, junction_turn, stop_index, command_id.

8. Khi status=received_task và người dùng nói "giao món đi", "bắt đầu giao", "đi giao đi" hoặc yêu cầu bắt đầu nhiệm vụ hiện tại, gọi start_delivery. Tool này dùng cùng luồng với nút BẮT ĐẦU trên giao diện.

9. Khi robot đang on_target và khách nói theo hướng không cần hỗ trợ thêm như "không cần", "cảm ơn", "thôi", "được rồi", KHÔNG gọi stop_listening. Hãy gọi finish_table_support để frontend nói câu chào bàn và bắt đầu hành trình trở về.

10. stop_listening chỉ dùng để kết thúc phiên nói chuyện thông thường khi robot KHÔNG ở giai đoạn hỗ trợ tại bàn. Không gọi stop_listening cho lời xác nhận giao món, lời "giao món đi", hoặc lời từ chối hỗ trợ khi status=on_target.

11. Khi stop_listening trả success=true, nói đúng một câu kết thúc lịch sự: "Nếu không có việc gì nữa thì em xin phép ạ, cần gì thì cứ gọi em ạ." rồi không hỏi thêm.

12. Các câu thông báo tự động khi tới bàn, chờ hỗ trợ, trở về station và hoàn thành giao món do frontend điều phối. Khi nhận một yêu cầu hệ thống bảo nói đúng nguyên văn, phải nói đúng câu đó và không thêm nội dung ngoài câu được yêu cầu.
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
            name: "read_robot_context",
            description:
              "Đọc ngữ cảnh robot hiện tại trực tiếp từ frontend: số robot đang chọn, trạng thái alive, work status, tasks, trạng thái món trên UI và dữ liệu của các robot. Bắt buộc gọi trước khi trả lời robot đang làm gì, đang đi đâu, giao món gì, đi bàn nào, đã tới chưa hoặc có đang rảnh không.",
            parameters: {
              type: "OBJECT",
              properties: {}
            }
          },
          {
            name: "read_table_info",
            description:
              "Đọc thông tin bàn từ backend. Nếu truyền table_number thì trả order/items của bàn đó; nếu không truyền thì trả trạng thái tổng quan của tất cả bàn.",
            parameters: {
              type: "OBJECT",
              properties: {
                table_number: {
                  type: "INTEGER",
                  description:
                    "Số bàn cần đọc. Có thể bỏ trống để lấy danh sách/tổng quan tất cả bàn."
                }
              }
            }
          },
          {
            name: "read_menu",
            description:
              "Đọc menu nhà hàng từ file data.js ở frontend để trả lời câu hỏi về món, giá, mô tả, nguyên liệu, tình trạng available và tư vấn món cho khách. Phải gọi tool này trước khi tư vấn menu.",
            parameters: {
              type: "OBJECT",
              properties: {
                query: {
                  type: "STRING",
                  description:
                    "Từ khóa hoặc nhu cầu cần tìm trong menu, ví dụ: 'bò', 'món cay', 'cà phê'. Để chuỗi rỗng nếu muốn đọc toàn bộ menu."
                },
                max_price: {
                  type: "NUMBER",
                  description:
                    "Giá tối đa tính bằng VND nếu khách có giới hạn ngân sách. Bỏ trống nếu không giới hạn."
                },
                available_only: {
                  type: "BOOLEAN",
                  description:
                    "Mặc định true: chỉ trả các món đang available."
                }
              }
            }
          },
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
            name: "prepare_task_replacement",
            description:
              "Chỉ dùng khi robot đang RECEIVED TASK, nhiệm vụ mới khác nhiệm vụ cũ, món mới đã check_table_food và quản lý đã xác nhận bỏ task cũ để thay bằng task mới. Frontend sẽ yêu cầu lấy món cũ ra, đặt món mới vào rồi mới thay database.",
            parameters: {
              type: "OBJECT",
              properties: {
                item_id: {
                  type: "INTEGER",
                  description: "ID món mới chính xác do check_table_food trả về."
                },
                table_number: {
                  type: "INTEGER",
                  description: "Số bàn của nhiệm vụ mới."
                }
              },
              required: ["item_id", "table_number"]
            }
          },
          {
            name: "start_delivery",
            description:
              "Bắt đầu task hiện tại khi robot đang RECEIVED TASK và người quản lý nói giao món đi/bắt đầu giao. Dùng cùng luồng với nút BẮT ĐẦU trên frontend.",
            parameters: {
              type: "OBJECT",
              properties: {}
            }
          },
          {
            name: "finish_table_support",
            description:
              "Dùng khi robot đang ON TARGET và khách nói không cần hỗ trợ thêm/cảm ơn/thôi. Frontend sẽ nói lời chào bàn rồi chuyển robot sang ON HOME để trở về.",
            parameters: {
              type: "OBJECT",
              properties: {}
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
          `Gemini voice=${window.APP_CONFIG.GEMINI_VOICE_NAME || "Aoede"} · Vietnamese/Hanoi style requested by system instruction`
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

      // turnComplete chỉ có nghĩa Gemini đã phát xong dữ liệu từ server; PCM
      // có thể vẫn còn trong hàng đợi loa. Chờ phần audio đã queue phát hết để
      // các state nghiệp vụ bắt đầu đúng sau câu nói (đặc biệt timer 10 giây
      // tại bàn và update delivered sau câu báo hoàn thành).
      try {
        await this.audio.waitForPlaybackDrain?.();
      } catch (_) {}

      try {
        this.onTurnComplete();
      } catch (_) {}

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
      "read_robot_context"
    ) {
      const context =
        this.getRobotContext?.() || {};

      const robotNumber = Number(
        context.robot_number ||
        this.getRobotNumber?.() ||
        1
      );

      const robot =
        context.robot && typeof context.robot === "object"
          ? context.robot
          : {};

      const status = String(
        robot.status || context.status || "available"
      )
        .trim()
        .toLowerCase();

      const task =
        robot.tasks &&
        typeof robot.tasks === "object" &&
        !Array.isArray(robot.tasks)
          ? robot.tasks
          : null;

      // task_type phân biệt loại nghiệp vụ của nhiệm vụ.
      // Các task cũ trong database chưa có field này đều là task giao món,
      // vì vậy fallback về food_delivery để không làm hỏng dữ liệu cũ.
      const taskTypeRaw = String(
        task?.task_type || ""
      )
        .trim()
        .toLowerCase();

      const taskType = task
        ? (taskTypeRaw || "food_delivery")
        : "";

      const foodName = String(
        task?.food_name || ""
      ).trim();

      const tableNumber = Number(task?.table);
      const hasTable = Number.isFinite(tableNumber) && tableNumber > 0;

      const missionText = (() => {
        const foodPart = foodName
          ? `món ${foodName}`
          : "món trong nhiệm vụ hiện tại";

        const tablePart = hasTable
          ? `bàn ${tableNumber}`
          : "bàn đích trong nhiệm vụ";

        if (status === "available") {
          return "Đang sẵn sàng làm việc và hiện chưa có nhiệm vụ đang thực hiện.";
        }

        if (status === "received_task") {
          if (taskType === "food_delivery") {
            return `Đã nhận nhiệm vụ chuẩn bị giao ${foodPart} tới ${tablePart}, nhưng chưa bắt đầu chạy. Có thể bấm BẮT ĐẦU hoặc ra lệnh "giao món đi" để thực thi.`;
          }
          return `Đã nhận nhiệm vụ loại ${taskType || "không xác định"} nhưng chưa bắt đầu chạy. Có thể bấm BẮT ĐẦU hoặc ra lệnh bắt đầu.`;
        }

        if (status === "on_task") {
          if (taskType === "food_delivery") {
            return `Đang thực hiện nhiệm vụ giao ${foodPart} tới ${tablePart}.`;
          }
          return `Đang thực hiện nhiệm vụ loại ${taskType || "không xác định"}.`;
        }

        if (status === "on_target") {
          if (taskType === "food_delivery") {
            return `Đã đến ${tablePart} với ${foodPart} và đang chờ khách lấy món khỏi robot.`;
          }
          return `Đã đến điểm đích của nhiệm vụ loại ${taskType || "không xác định"} và đang chờ hoàn tất tác vụ tại đích.`;
        }

        if (
          status === "on_home" ||
          status === "come_home" ||
          status === "come_back"
        ) {
          if (taskType === "food_delivery") {
            return `Đã giao ${foodPart} tới ${tablePart} và đang trên đường trở về vị trí chờ của robot.`;
          }
          return "Đang trên đường trở về vị trí chờ của robot.";
        }

        if (status === "abnormal_behavior") {
          return "Robot đang ở trạng thái hoạt động bất thường. Chưa có dữ liệu xác định nguyên nhân cụ thể.";
        }

        return `Trạng thái công việc hiện tại là ${status || "không xác định"}.`;
      })();

      return {
        success: true,
        source: "frontend_runtime_state",
        robot_number: robotNumber,
        robot_key: context.robot_key || `robot_${robotNumber}`,
        alive: String(context.alive || "disconnected").toLowerCase(),
        status,
        task_type: taskType || null,
        work_summary: missionText,
        tasks: task,
        has_food_frontend: context.has_food_frontend ?? null,
        food_state_label: context.food_state_label || "",
        robot,
        all_robots: context.all_robots || {}
      };
    }

    if (
      name ===
      "read_table_info"
    ) {
      const tableNumber = Number(args?.table_number);

      if (Number.isFinite(tableNumber) && tableNumber > 0) {
        const result = await this.authFetch(
          `/orders/table/${tableNumber}`,
          { method: "GET" }
        );

        return {
          success: true,
          source: "backend/orders/table",
          ...result
        };
      }

      const result = await this.authFetch(
        "/orders/tables/status",
        { method: "GET" }
      );

      return {
        success: true,
        source: "backend/orders/tables/status",
        ...result
      };
    }

    if (
      name ===
      "read_menu"
    ) {
      const menu = Array.isArray(window.MENU_DATA)
        ? window.MENU_DATA
        : [];

      if (!menu.length) {
        throw new Error(
          "Không đọc được MENU_DATA từ data.js."
        );
      }

      const query = String(args?.query || "")
        .trim()
        .toLocaleLowerCase("vi-VN");

      const maxPriceRaw = Number(args?.max_price);
      const hasMaxPrice = Number.isFinite(maxPriceRaw) && maxPriceRaw >= 0;

      const availableOnly =
        args?.available_only !== false;

      const normalize = (value) =>
        String(value ?? "")
          .trim()
          .toLocaleLowerCase("vi-VN");

      const items = menu.filter((item) => {
        if (availableOnly && item.available !== true) {
          return false;
        }

        if (hasMaxPrice && Number(item.price) > maxPriceRaw) {
          return false;
        }

        if (!query) {
          return true;
        }

        const searchable = [
          item.id,
          item.name,
          ...(Array.isArray(item.aliases) ? item.aliases : []),
          item.description,
          ...(Array.isArray(item.ingredients) ? item.ingredients : [])
        ]
          .map(normalize)
          .join(" ");

        return searchable.includes(query);
      });

      return {
        success: true,
        source: "frontend/data.js",
        query,
        max_price: hasMaxPrice ? maxPriceRaw : null,
        available_only: availableOnly,
        total_menu_items: menu.length,
        matched_count: items.length,
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          aliases: Array.isArray(item.aliases) ? item.aliases : [],
          price: Number(item.price),
          currency: item.currency || "VND",
          unit: item.unit || "phần",
          description: item.description || "",
          ingredients: Array.isArray(item.ingredients)
            ? item.ingredients
            : [],
          available: item.available === true
        }))
      };
    }

    if (
      name ===
      "check_table_food"
    ) {
      const requestedTable = Number(args.table_number);
      const requestedFood = String(args.food_name || "");
      const result = await this.authFetch(
        "/robot-ai/check-food",
        {
          method: "POST",
          body: JSON.stringify({
            table_number: requestedTable,
            food_name: requestedFood
          })
        }
      );

      // Khi robot đang RECEIVED TASK, cùng món + cùng bàn được coi là cùng
      // nhiệm vụ theo câu lệnh quản lý. Không phụ thuộc backend có chọn một
      // order-item trùng tên khác hay món hiện tại đang ở trạng thái dispatched.
      const context = this.getRobotContext?.() || {};
      const robot = context.robot && typeof context.robot === "object"
        ? context.robot
        : {};
      const status = String(robot.status || context.status || "available")
        .trim()
        .toLowerCase();
      const currentTask = robot.tasks && typeof robot.tasks === "object" && !Array.isArray(robot.tasks)
        ? robot.tasks
        : null;
      const normalizeTaskText = (value) => String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const sameAsCurrentTask = Boolean(
        status === "received_task" &&
        currentTask &&
        Number(currentTask.table) === requestedTable &&
        normalizeTaskText(currentTask.food_name) === normalizeTaskText(requestedFood)
      );

      const enriched = {
        ...result,
        same_as_current_task: sameAsCurrentTask,
        current_task: status === "received_task" && currentTask
          ? { ...currentTask }
          : null
      };

      this.lastFoodCheck = enriched;
      return enriched;
    }

    if (
      name ===
      "prepare_delivery"
    ) {
      const context = this.getRobotContext?.() || {};
      const robot = context.robot && typeof context.robot === "object"
        ? context.robot
        : {};
      const status = String(robot.status || context.status || "available")
        .trim()
        .toLowerCase();
      const alive = String(context.alive || "disconnected")
        .trim()
        .toLowerCase();

      if (alive !== "alive") {
        return {
          success: true,
          accepted: false,
          reason: "robot_not_alive",
          message: "Hãy bật robot lên ạ."
        };
      }

      if (status !== "available") {
        return {
          success: true,
          accepted: false,
          reason: "robot_not_available",
          status,
          message: "Robot không ở trạng thái AVAILABLE nên không thể nhận task mới theo luồng này."
        };
      }

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
        waiting_for_food: context.has_food_frontend !== true,
        has_food_frontend: context.has_food_frontend ?? null,
        item_id: checkedItemId,
        table_number: checkedTable,
        table: checkedTable,
        food_name: checked.item.food_name,
        route: checked.route,
        message: context.has_food_frontend === true
          ? "Món đã có trên robot. Frontend sẽ commit dispatch ngay."
          : "Đã nhận yêu cầu. Hãy mau đặt món lên robot."
      };
    }

    if (
      name ===
      "prepare_task_replacement"
    ) {
      const context = this.getRobotContext?.() || {};
      const robot = context.robot && typeof context.robot === "object"
        ? context.robot
        : {};
      const status = String(robot.status || context.status || "available")
        .trim()
        .toLowerCase();
      const alive = String(context.alive || "disconnected")
        .trim()
        .toLowerCase();
      const oldTask = robot.tasks && typeof robot.tasks === "object" && !Array.isArray(robot.tasks)
        ? robot.tasks
        : null;

      if (alive !== "alive") {
        return {
          success: true,
          accepted: false,
          reason: "robot_not_alive",
          message: "Hãy bật robot lên ạ."
        };
      }

      if (status !== "received_task" || !oldTask) {
        throw new Error("Robot không còn ở RECEIVED TASK để thay nhiệm vụ.");
      }

      const checked = this.lastFoodCheck;
      if (!checked?.found || !checked?.deliverable || !checked?.item) {
        throw new Error("Món mới chưa có kết quả check_table_food hợp lệ/deliverable.");
      }

      const itemId = Number(args.item_id);
      const tableNumber = Number(args.table_number);
      const checkedItemId = Number(checked.item.id);
      const checkedTable = Number(checked.table_number);

      if (itemId !== checkedItemId || tableNumber !== checkedTable) {
        throw new Error("Món mới không khớp kết quả check_table_food gần nhất.");
      }
      const normalizeTaskText = (value) => String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const sameTask =
        Number(oldTask.item_id) === checkedItemId ||
        (
          Number(oldTask.table) === checkedTable &&
          normalizeTaskText(oldTask.food_name) === normalizeTaskText(checked.item.food_name)
        );

      if (sameTask) {
        return {
          success: true,
          accepted: false,
          same_task: true,
          message: "Nhiệm vụ mới trùng task hiện tại. Hãy bấm Bắt đầu hoặc ra lệnh giao món đi."
        };
      }

      const oldFoodName = String(oldTask.food_name || "món cũ");
      const oldTable = Number(oldTask.table) || "hiện tại";
      const newFoodName = String(checked.item.food_name || "món mới");
      const hasFoodFrontend = context.has_food_frontend === true;
      const prompt = hasFoodFrontend
        ? `Vâng ạ, vui lòng lấy món ${oldFoodName} của bàn ${oldTable} ra khỏi robot trước ạ.`
        : `Vâng ạ, vui lòng đặt món ${newFoodName} của bàn ${checkedTable} lên robot ạ.`;

      return {
        success: true,
        accepted: true,
        replacement: true,
        old_task: { ...oldTask },
        item_id: checkedItemId,
        table_number: checkedTable,
        table: checkedTable,
        food_name: newFoodName,
        route: checked.route,
        has_food_frontend: context.has_food_frontend ?? null,
        next_action: hasFoodFrontend ? "remove_old_food" : "place_new_food",
        prompt,
        message: "Đã xác nhận thay task. Frontend đang chờ thao tác món vật lý theo cảm biến trước khi cập nhật database."
      };
    }

    if (
      name ===
      "start_delivery"
    ) {
      const context = this.getRobotContext?.() || {};
      const robot = context.robot && typeof context.robot === "object"
        ? context.robot
        : {};
      const status = String(robot.status || context.status || "available")
        .trim()
        .toLowerCase();
      const alive = String(context.alive || "disconnected")
        .trim()
        .toLowerCase();
      const task = robot.tasks && typeof robot.tasks === "object" && !Array.isArray(robot.tasks)
        ? robot.tasks
        : null;

      if (alive !== "alive") {
        return {
          success: true,
          accepted: false,
          status,
          message: "Hãy bật robot lên ạ."
        };
      }

      if (status !== "received_task" || !task) {
        return {
          success: true,
          accepted: false,
          status,
          message: "Robot chưa có task RECEIVED TASK để bắt đầu."
        };
      }

      return {
        success: true,
        accepted: true,
        task: { ...task },
        message: "Frontend sẽ bắt đầu task hiện tại bằng cùng luồng với nút BẮT ĐẦU."
      };
    }

    if (
      name ===
      "finish_table_support"
    ) {
      const context = this.getRobotContext?.() || {};
      const robot = context.robot && typeof context.robot === "object"
        ? context.robot
        : {};
      const status = String(robot.status || context.status || "available")
        .trim()
        .toLowerCase();

      if (status !== "on_target") {
        return {
          success: true,
          accepted: false,
          status,
          message: "Robot không ở ON TARGET nên không kết thúc hỗ trợ tại bàn."
        };
      }

      return {
        success: true,
        accepted: true,
        message: "Frontend sẽ nói lời chào tại bàn rồi chuyển robot sang ON HOME."
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